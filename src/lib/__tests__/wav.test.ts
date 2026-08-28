/**
 * The file format, pinned byte by byte.
 *
 * A WAV that is wrong by a few bytes in its header opens perfectly in one host
 * and not at all in another, and the failure surfaces days later on someone
 * else's machine. These are the checks that make that a build failure instead.
 */

import { describe, expect, it } from 'vitest';
import {
  RIFF_LIMIT,
  decode,
  encode,
  frameBytes,
  readWavInfo,
  sizePatches,
  wavHeader,
  type SampleFormat,
} from '../wav';

const ascii = (b: Uint8Array, at: number, len: number) =>
  String.fromCharCode(...b.subarray(at, at + len));

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at, true);
const u16 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint16(at, true);

/** Apply the patches to a header, as the writer does when a take stops. */
function finish(format: SampleFormat, sampleRate: number, frames: number): Uint8Array {
  const h = wavHeader(sampleRate, format);
  const out = h.bytes.slice();
  for (const p of sizePatches(h, frames, format)) out.set(p.data, p.position);
  return out;
}

describe('wavHeader', () => {
  it('writes a float header with a fact chunk', () => {
    const { bytes } = wavHeader(48000, 'float32');
    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(ascii(bytes, 8, 4)).toBe('WAVE');
    expect(ascii(bytes, 12, 4)).toBe('fmt ');
    expect(u32(bytes, 16)).toBe(16);
    expect(u16(bytes, 20)).toBe(3); // IEEE float
    expect(u16(bytes, 22)).toBe(1); // mono
    expect(u32(bytes, 24)).toBe(48000);
    expect(u32(bytes, 28)).toBe(48000 * 4); // byte rate
    expect(u16(bytes, 32)).toBe(4); // block align
    expect(u16(bytes, 34)).toBe(32); // bits
    // The spec requires a fact chunk for any non-PCM format. Most readers
    // ignore it; the ones that do not are the reason it is here.
    expect(ascii(bytes, 36, 4)).toBe('fact');
    expect(ascii(bytes, 48, 4)).toBe('data');
    expect(bytes.length).toBe(56);
  });

  it('writes a 24-bit PCM header with no fact chunk', () => {
    const { bytes, patches } = wavHeader(96000, 'int24');
    expect(u16(bytes, 20)).toBe(1); // PCM
    expect(u16(bytes, 34)).toBe(24);
    expect(u32(bytes, 28)).toBe(96000 * 3);
    expect(ascii(bytes, 36, 4)).toBe('data');
    expect(bytes.length).toBe(44);
    expect(patches.factFrames).toBeNull();
  });
});

describe('sizePatches', () => {
  // The classic WAV bug: RIFF's size counts everything *after* its own field,
  // not the file length. Off by eight is a file that opens in some hosts and
  // not others, which is far worse than one that opens in none.
  it('sets the RIFF size to the file length less eight', () => {
    for (const format of ['float32', 'int24'] as SampleFormat[]) {
      const frames = 1000;
      const bytes = finish(format, 48000, frames);
      const dataBytes = frames * frameBytes(format);
      expect(u32(bytes, 4)).toBe(bytes.length - 8 + dataBytes);
    }
  });

  it('sets the data size and, for float, the frame count', () => {
    const frames = 12345;
    const f = finish('float32', 48000, frames);
    // fact's body starts at 44: RIFF (12) + fmt chunk (24) + 'fact' + its size.
    expect(u32(f, 44)).toBe(frames);
    expect(u32(f, 52)).toBe(frames * 4); // data
    const i = finish('int24', 48000, frames);
    expect(u32(i, 40)).toBe(frames * 3);
  });

  it('produces a header its own parser reads back', () => {
    for (const format of ['float32', 'int24'] as SampleFormat[]) {
      for (const rate of [44100, 48000, 96000, 192000]) {
        const info = readWavInfo(finish(format, rate, 4321));
        expect(info.sampleRate).toBe(rate);
        expect(info.channels).toBe(1);
        expect(info.format).toBe(format);
        expect(info.frames).toBe(4321);
        expect(info.dataOffset).toBe(format === 'float32' ? 56 : 44);
      }
    }
  });
});

describe('readWavInfo', () => {
  it('walks past chunks it does not know', () => {
    // A file that has been through another tool may carry LIST, bext or iXML
    // between fmt and data. A parser that assumes fixed offsets reads the audio
    // as if it started in the middle of someone else's metadata.
    const base = finish('int24', 48000, 100);
    // An odd body length, so the pad byte that follows it is exercised. An even
    // one would pass against a walker that has forgotten padding entirely.
    const extra = 11;
    const out = new Uint8Array(base.length + 8 + extra + 1);
    out.set(base.subarray(0, 36), 0); // RIFF + fmt
    let p = 36;
    out.set([0x4c, 0x49, 0x53, 0x54], p); // 'LIST'
    new DataView(out.buffer).setUint32(p + 4, extra, true);
    p += 8 + extra + 1; // body plus the pad byte an odd length demands
    out.set(base.subarray(36), p);

    const info = readWavInfo(out);
    expect(info.format).toBe('int24');
    expect(info.frames).toBe(100);
    expect(info.dataOffset).toBe(p + 8);
  });

  it('rejects what it cannot play rather than guessing', () => {
    const bytes = finish('float32', 48000, 10);
    new DataView(bytes.buffer).setUint16(34, 16, true); // claim 16-bit float
    expect(() => readWavInfo(bytes)).toThrow(/unsupported/);
    expect(() => readWavInfo(new Uint8Array(64))).toThrow(/RIFF/);
  });
});

describe('encode', () => {
  it('round-trips float32 exactly', () => {
    const samples = Float32Array.from([0, 1, -1, 0.5, -0.5, 1e-9, 0.123456789]);
    const out = new Uint8Array(samples.length * 4);
    expect(encode(samples, samples.length, 'float32', out)).toBe(samples.length * 4);
    const back = new Float32Array(samples.length);
    decode(out, 'float32', back);
    // Float32 in, float32 out: this must be bit-exact, not merely close. Any
    // tolerance here would hide a byte-order mistake.
    for (let i = 0; i < samples.length; i++) expect(back[i]).toBe(samples[i]);
  });

  it('writes 24-bit little-endian', () => {
    const out = new Uint8Array(6);
    encode(Float32Array.from([0.5, -0.5]), 2, 'int24', out);
    // 0.5 * 2^23 = 4194304 = 0x400000
    expect([...out.subarray(0, 3)]).toEqual([0x00, 0x00, 0x40]);
    // -0.5 -> -4194304 -> two's complement 0xC00000
    expect([...out.subarray(3, 6)]).toEqual([0x00, 0x00, 0xc0]);
  });

  it('clamps rather than wrapping at full scale', () => {
    // The bug this guards: +1.0 scales to +8388608, which does not fit in a
    // signed 24-bit word and truncates to -8388608. A clipped take would come
    // back not merely clipped but inverted at every peak, which sounds like the
    // recording was destroyed rather than merely hot.
    const out = new Uint8Array(12);
    encode(Float32Array.from([1, 1.5, -1, -2]), 4, 'int24', out);
    const back = new Float32Array(4);
    decode(out, 'int24', back);
    expect(back[0]).toBeCloseTo(1, 5);
    expect(back[1]).toBeCloseTo(1, 5);
    expect(back[2]).toBe(-1);
    expect(back[3]).toBe(-1);
    expect(Math.max(...back)).toBeLessThan(1.0000001);
    expect(Math.min(...back)).toBeGreaterThanOrEqual(-1);
  });

  it('keeps 24-bit round-trip error inside one quantisation step', () => {
    const n = 4096;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.sin((i / n) * Math.PI * 2 * 7) * 0.9;
    const out = new Uint8Array(n * 3);
    encode(samples, n, 'int24', out);
    const back = new Float32Array(n);
    decode(out, 'int24', back);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(back[i] - samples[i]));
    // Half a step is the most a correct round-to-nearest can be out by.
    expect(worst).toBeLessThanOrEqual(0.5 / 8388608 + 1e-12);
  });
});

describe('the 4 GB ceiling', () => {
  it('is where a uint32 data size runs out', () => {
    // Not arbitrary, and not something a different writer could avoid: RIFF
    // holds its sizes in unsigned 32-bit fields.
    expect(RIFF_LIMIT).toBe(0xffffffff);
    const hours = RIFF_LIMIT / (48000 * 4) / 3600;
    expect(hours).toBeGreaterThan(6);
    expect(hours).toBeLessThan(6.3);
  });
});
