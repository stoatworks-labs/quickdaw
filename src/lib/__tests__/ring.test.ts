/**
 * The ring, including the two behaviours nothing else can check.
 *
 * The wrap at 2^32 frames happens once every 24.8 hours at 48 kHz, and the
 * overrun path only happens when a disk stalls for longer than the buffer
 * holds. Neither is reachable in a test session, and both are exactly where a
 * recorder quietly produces a wrong file. They are reachable here because the
 * positions are just numbers.
 */

import { describe, expect, it } from 'vitest';
import {
  AUDIO_OFFSET,
  CTRL_CAPACITY,
  CTRL_CHANNELS,
  CTRL_READ,
  CTRL_WRITE,
  createRing,
  ringAvailable,
  ringBytes,
  ringChannel,
  ringControl,
  ringFree,
  ringRead,
  ringWrite,
  unwrapPosition,
} from '../ring';

describe('createRing', () => {
  it('rounds the capacity up to whole render quanta', () => {
    expect(createRing(2, 1000, 48000).capacity).toBe(1024);
    expect(createRing(2, 1024, 48000).capacity).toBe(1024);
    expect(createRing(2, 1025, 48000).capacity).toBe(1152);
  });

  it('records its own shape where the worklet can read it', () => {
    const ring = createRing(8, 48000, 48000);
    const ctrl = ringControl(ring.sab);
    expect(ctrl[CTRL_CHANNELS]).toBe(8);
    expect(ctrl[CTRL_CAPACITY]).toBe(ring.capacity);
    expect(ring.sab.byteLength).toBe(ringBytes(8, ring.capacity));
  });

  it('gives each channel a private, contiguous run', () => {
    const ring = createRing(4, 512, 48000);
    for (let ch = 0; ch < 4; ch++) {
      const view = ringChannel(ring.sab, ch, ring.capacity);
      expect(view.length).toBe(ring.capacity);
      expect(view.byteOffset).toBe(AUDIO_OFFSET + ch * ring.capacity * 4);
      view.fill(ch + 1);
    }
    // Writing one channel must not have touched another — the whole planar
    // layout rests on the views not overlapping.
    for (let ch = 0; ch < 4; ch++) {
      const view = ringChannel(ring.sab, ch, ring.capacity);
      expect(view.every((v) => v === ch + 1)).toBe(true);
    }
  });
});

describe('ringRead and ringWrite', () => {
  it('come back with what went in, across the seam', () => {
    const capacity = 256;
    const data = new Float32Array(capacity);
    const source = Float32Array.from({ length: 100 }, (_, i) => i + 1);
    const out = new Float32Array(100);

    // Deliberately straddling the wrap: the second half of this write lands at
    // the start of the buffer, and a reader that does not split the same way
    // returns the wrong hundred samples.
    ringWrite(data, capacity, 200, 100, source);
    ringRead(data, capacity, 200, 100, out);
    expect([...out]).toEqual([...source]);
  });

  it('reads at an absolute position, not a modulo one', () => {
    const capacity = 128;
    const data = new Float32Array(capacity);
    const source = Float32Array.from({ length: 128 }, (_, i) => i);
    ringWrite(data, capacity, 0, 128, source);
    const out = new Float32Array(10);
    // A position several laps in must land in the same place as its remainder.
    ringRead(data, capacity, 128 * 5 + 20, 10, out);
    expect([...out]).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  });
});

describe('ringAvailable', () => {
  const capacity = 1024;
  const ctrl = () => new Int32Array(16);

  it('reports the gap between the two positions', () => {
    const c = ctrl();
    Atomics.store(c, CTRL_WRITE, 500);
    expect(ringAvailable(c, capacity, 100)).toEqual({ frames: 400, lost: 0 });
  });

  it('is correct across the producer’s wrap at 2^32', () => {
    // 24.8 hours into a session at 48 kHz. The subtraction has to be done in
    // the same modulus or the reader sees four billion frames available and
    // walks the whole buffer as if it were one enormous valid span.
    const c = ctrl();
    Atomics.store(c, CTRL_WRITE, 50); // wrapped past zero
    const read = 0xffffff00; // 256 frames before the wrap
    expect(ringAvailable(c, capacity, read)).toEqual({ frames: 306, lost: 0 });
  });

  it('says exactly how much was lost when the producer laps the reader', () => {
    const c = ctrl();
    Atomics.store(c, CTRL_WRITE, 1500);
    // The reader is 1500 frames behind a 1024-frame ring: 476 frames no longer
    // exist. The writer pads exactly that many so the take keeps its length.
    expect(ringAvailable(c, capacity, 0)).toEqual({ frames: capacity, lost: 476 });
  });

  it('does not call a exactly-full ring an overrun', () => {
    const c = ctrl();
    Atomics.store(c, CTRL_WRITE, capacity);
    expect(ringAvailable(c, capacity, 0)).toEqual({ frames: capacity, lost: 0 });
  });
});

describe('ringFree', () => {
  it('leaves one frame so full and empty stay distinguishable', () => {
    const c = new Int32Array(16);
    expect(ringFree(c, 1024)).toBe(1023);
    Atomics.store(c, CTRL_WRITE, 1023);
    expect(ringFree(c, 1024)).toBe(0);
    Atomics.store(c, CTRL_READ, 1023);
    expect(ringFree(c, 1024)).toBe(1023);
  });
});

describe('unwrapPosition', () => {
  it('keeps counting past 2^32', () => {
    const wrap = 2 ** 32;
    let abs = 0;
    abs = unwrapPosition(abs, 1000);
    expect(abs).toBe(1000);
    abs = unwrapPosition(abs, (wrap - 100) >>> 0);
    expect(abs).toBe(wrap - 100);
    // The low word goes backwards; the absolute count must not.
    abs = unwrapPosition(abs, 50);
    expect(abs).toBe(wrap + 50);
    abs = unwrapPosition(abs, 60);
    expect(abs).toBe(wrap + 60);
  });

  it('survives many wraps without drifting', () => {
    const wrap = 2 ** 32;
    let abs = 0;
    let truth = 0;
    const step = 0x40000000; // a quarter of the range at a time
    for (let i = 0; i < 40; i++) {
      truth += step;
      abs = unwrapPosition(abs, truth >>> 0);
      expect(abs).toBe(truth);
    }
    expect(truth).toBeGreaterThan(wrap * 9);
  });
});
