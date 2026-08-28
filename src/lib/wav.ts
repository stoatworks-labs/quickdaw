/**
 * WAV writing, in the form a streaming recorder needs.
 *
 * A recorder does not know how long a take is until it stops, and a RIFF file
 * declares its length in its first twelve bytes. So the header goes down first
 * with zeroed sizes, the audio streams after it, and the sizes are patched by
 * seeking back at stop. `sizePatches` returns exactly where those writes go.
 *
 * Two formats, and no others:
 *
 * - **32-bit float** is the default. It cannot clip in the file, so a take that
 *   overloaded the converter is still recoverable to whatever the converter
 *   gave, and no dither decision has to be made at record time.
 * - **24-bit int** for hosts and utilities that will not take float, at a fifth
 *   less disk. Values are clamped, so this format *can* clip.
 *
 * 16-bit is deliberately absent. Truncating to 16 bits properly needs dither,
 * dither at record time is a choice that belongs at the end of a chain rather
 * than the start, and undithered 16-bit is the wrong default to offer someone
 * who did not think about it.
 */

export type SampleFormat = 'float32' | 'int24';

export const SAMPLE_FORMATS: Record<SampleFormat, { label: string; bytes: number; hint: string }> = {
  float32: { label: '32-bit float', bytes: 4, hint: 'Cannot clip in the file. The default.' },
  int24: { label: '24-bit', bytes: 3, hint: '25% smaller. Clamps at full scale.' },
};

/** Bytes one frame of a mono track occupies. */
export function frameBytes(format: SampleFormat): number {
  return SAMPLE_FORMATS[format].bytes;
}

/**
 * RIFF sizes are unsigned 32-bit, so no WAV can exceed 4 GiB however it is
 * written. At 48 kHz 32-bit float that is a little over six hours on one mono
 * track; at 96 kHz, three. The recorder watches this and stops cleanly rather
 * than writing a file whose header cannot describe it.
 */
export const RIFF_LIMIT = 0xffffffff;

export interface WavHeader {
  bytes: Uint8Array<ArrayBuffer>;
  /** Byte offsets of the fields that are only known at stop. */
  patches: { riffSize: number; dataSize: number; factFrames: number | null };
}

/**
 * Build the header for a mono track.
 *
 * Mono per file, one file per input: a multitrack take is a folder of mono WAVs
 * rather than one interleaved file. That is what every DAW imports without
 * asking questions, it lets a single track be disarmed without disturbing the
 * others, and it means a take that is interrupted still leaves every completed
 * track readable.
 *
 * The float form carries a `fact` chunk. It is optional in practice — most
 * readers ignore it — but the spec requires it for any non-PCM format, and it
 * costs twelve bytes to be correct rather than merely widely accepted.
 */
export function wavHeader(sampleRate: number, format: SampleFormat): WavHeader {
  const float = format === 'float32';
  const bits = float ? 32 : 24;
  const blockAlign = frameBytes(format);
  const factLen = float ? 12 : 0;
  const size = 12 + 24 + factLen + 8;

  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let p = 0;
  const ascii = (s: string) => {
    for (let i = 0; i < s.length; i++) bytes[p + i] = s.charCodeAt(i);
    p += s.length;
  };
  const u32 = (v: number) => {
    view.setUint32(p, v, true);
    p += 4;
  };
  const u16 = (v: number) => {
    view.setUint16(p, v, true);
    p += 2;
  };

  ascii('RIFF');
  const riffSize = p;
  u32(0);
  ascii('WAVE');

  ascii('fmt ');
  u32(16);
  u16(float ? 3 : 1); // 3 = IEEE float, 1 = PCM
  u16(1); // mono
  u32(sampleRate);
  u32(sampleRate * blockAlign); // byte rate
  u16(blockAlign);
  u16(bits);

  let factFrames: number | null = null;
  if (float) {
    ascii('fact');
    u32(4);
    factFrames = p;
    u32(0);
  }

  ascii('data');
  const dataSize = p;
  u32(0);

  return { bytes, patches: { riffSize, dataSize, factFrames } };
}

export interface SizePatch {
  position: number;
  data: Uint8Array<ArrayBuffer>;
}

/**
 * The writes that turn a streamed file into a valid one.
 *
 * `riffSize` counts everything after itself, which is the whole file less the
 * eight bytes of `RIFF` and the size field — not the file length, and getting
 * that wrong by eight is the classic way to produce a WAV that opens in one
 * host and not another.
 */
export function sizePatches(header: WavHeader, frames: number, format: SampleFormat): SizePatch[] {
  const dataBytes = frames * frameBytes(format);
  const patches: SizePatch[] = [
    { position: header.patches.riffSize, data: u32le(header.bytes.length - 8 + dataBytes) },
    { position: header.patches.dataSize, data: u32le(dataBytes) },
  ];
  if (header.patches.factFrames !== null) {
    patches.push({ position: header.patches.factFrames, data: u32le(frames) });
  }
  return patches;
}

function u32le(v: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v >>> 0, true);
  return out;
}

/**
 * True on a little-endian host, which every platform a browser runs on is.
 *
 * WAV is little-endian, so on such a host a Float32Array's own bytes are
 * already the file's bytes and the float path is a straight memory copy. The
 * check exists so the fallback below is reachable rather than theoretical, and
 * so nothing silently writes byte-swapped audio on a machine that surprises us.
 */
export const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Encode `frames` samples of one channel into WAV byte order.
 *
 * Writes into `out`, which must be at least `frames * frameBytes(format)` long,
 * and returns the number of bytes written. Reusing a caller-owned buffer keeps
 * this off the allocator: it runs every quarter second per track for the whole
 * length of a take.
 */
export function encode(
  samples: Float32Array,
  frames: number,
  format: SampleFormat,
  out: Uint8Array<ArrayBuffer>,
): number {
  if (format === 'float32') {
    const bytes = frames * 4;
    if (LITTLE_ENDIAN) {
      out.set(new Uint8Array(samples.buffer, samples.byteOffset, bytes), 0);
    } else {
      const view = new DataView(out.buffer, out.byteOffset, bytes);
      for (let i = 0; i < frames; i++) view.setFloat32(i * 4, samples[i], true);
    }
    return bytes;
  }

  // 24-bit. Scale by 2^23 and clamp to the asymmetric integer range: +8388607
  // is the largest representable value, so a sample of exactly +1.0 must land
  // there rather than wrapping to full-scale negative, which is what a bare
  // truncation does and what makes a clipped 24-bit take sound torn apart
  // rather than merely clipped.
  let p = 0;
  for (let i = 0; i < frames; i++) {
    let v = Math.round(samples[i] * 8388608);
    if (v > 8388607) v = 8388607;
    else if (v < -8388608) v = -8388608;
    out[p++] = v & 0xff;
    out[p++] = (v >> 8) & 0xff;
    out[p++] = (v >> 16) & 0xff;
  }
  return p;
}

/**
 * Decode WAV bytes back to floats, for playback.
 *
 * Only the two formats this app writes are handled; `readWavInfo` rejects
 * anything else before a byte gets here.
 */
export function decode(
  bytes: Uint8Array,
  format: SampleFormat,
  out: Float32Array,
): number {
  if (format === 'float32') {
    const frames = Math.floor(bytes.length / 4);
    if (LITTLE_ENDIAN && bytes.byteOffset % 4 === 0) {
      out.set(new Float32Array(bytes.buffer, bytes.byteOffset, frames), 0);
    } else {
      const view = new DataView(bytes.buffer, bytes.byteOffset, frames * 4);
      for (let i = 0; i < frames; i++) out[i] = view.getFloat32(i * 4, true);
    }
    return frames;
  }
  const frames = Math.floor(bytes.length / 3);
  for (let i = 0; i < frames; i++) {
    const p = i * 3;
    // Sign-extend 24 bits by shifting the top byte into bit 31 and back down.
    const v = ((bytes[p] << 8) | (bytes[p + 1] << 16) | (bytes[p + 2] << 24)) >> 8;
    out[i] = v / 8388608;
  }
  return frames;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  format: SampleFormat;
  /** Byte offset of the first audio byte. */
  dataOffset: number;
  /** Length of the data chunk in bytes, as the header declares it. */
  dataBytes: number;
  frames: number;
}

/**
 * Parse enough of a WAV header to play the file back.
 *
 * Chunks are walked rather than assumed at fixed offsets: our own writer puts a
 * `fact` chunk between `fmt ` and `data` for float files, and any file that has
 * been through another tool may carry `LIST`, `bext` or `iXML` as well. Odd-
 * length chunks are followed by a pad byte, which is the detail that makes a
 * naive walker land one byte into the next chunk id.
 */
export function readWavInfo(header: Uint8Array): WavInfo {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const tag = (o: number) => String.fromCharCode(header[o], header[o + 1], header[o + 2], header[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');

  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let audioFormat = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  let p = 12;
  while (p + 8 <= header.length) {
    const id = tag(p);
    const size = view.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'fmt ' && body + 16 <= header.length) {
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (audioFormat === 0xfffe && body + 26 <= header.length) {
        // WAVE_FORMAT_EXTENSIBLE hides the real format in the first two bytes
        // of its GUID sub-format field.
        audioFormat = view.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataOffset = body;
      dataBytes = size;
      break; // the audio starts here; nothing after it needs reading to play it
    }
    p = body + size + (size & 1); // chunks pad to even
  }

  if (dataOffset < 0) throw new Error('no data chunk');
  let format: SampleFormat;
  if (audioFormat === 3 && bits === 32) format = 'float32';
  else if (audioFormat === 1 && bits === 24) format = 'int24';
  else throw new Error(`unsupported WAV format ${audioFormat} at ${bits}-bit`);

  const align = frameBytes(format) * Math.max(1, channels);
  return {
    sampleRate,
    channels,
    format,
    dataOffset,
    dataBytes,
    frames: Math.floor(dataBytes / align),
  };
}
