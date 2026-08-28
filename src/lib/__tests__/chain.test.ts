/**
 * The producer and the consumer, run against each other.
 *
 * The ring's own tests check its arithmetic in isolation. This checks the
 * property the whole recorder rests on, by driving both ends the way the
 * worklet and the writer drive them — 128 frames at a time in, a chunk at a
 * time out, with the consumer stalling at arbitrary moments:
 *
 *   **the take is the same length as the time it covers, and every sample in it
 *   is at the position it was captured at.**
 *
 * That is the invariant a recorder is judged by. It survives a disk stall
 * because a stall costs *content* (padded with silence, and counted) and never
 * *time*. A writer that instead skipped the lost frames would produce a file
 * that is shorter than the take and drags everything after the gap early —
 * identically on every track, so it would still look perfectly in sync with
 * itself while being wrong against the world. That is the failure this file
 * exists to make impossible.
 */

import { describe, expect, it } from 'vitest';
import {
  CTRL_WRITE,
  createRing,
  ringAvailable,
  ringChannel,
  ringControl,
  ringRead,
} from '../ring';

const QUANTUM = 128;

/** A sample whose value identifies the frame it was captured at. */
const sampleAt = (frame: number) => Math.sin(frame * 0.001) * 0.5;

interface Result {
  /** What the writer produced, in order, as one track's file would hold it. */
  file: number[];
  produced: number;
  /** Frame the take's first sample was captured at. */
  takeStart: number;
  /** Frame that had been reached when record was pressed. */
  pressedAt: number;
  lost: number;
  gaps: { atFrame: number; frames: number }[];
}

/**
 * Drive the ring exactly as the two real ends do.
 *
 * `stallAt` names the consumer passes that do nothing, which is how a disk
 * hiccup presents: the producer carries on regardless, and if the stall lasts
 * longer than the ring holds, frames are gone.
 */
function run(opts: {
  capacityFrames: number;
  quanta: number;
  chunk: number;
  /** Consumer runs every `every` producer quanta. */
  every: number;
  stalls?: Set<number>;
  preRollFrames?: number;
  /** Producer quantum on which record is pressed. Default: the first. */
  pressAt?: number;
}): Result {
  const ring = createRing(1, opts.capacityFrames, 48000);
  const ctrl = ringControl(ring.sab);
  const data = ringChannel(ring.sab, 0, ring.capacity);

  const file: number[] = [];
  const gaps: { atFrame: number; frames: number }[] = [];
  const scratch = new Float32Array(opts.chunk);
  let produced = 0;
  let read = 0;
  let started = false;
  let takeStart = 0;
  let pressedAt = 0;
  let lost = 0;
  let frames = 0;

  const consume = (drain: boolean) => {
    if (!started) return;
    const span = ringAvailable(ctrl, ring.capacity, read);
    if (span.lost > 0) {
      // The writer's rule: pad the hole, record it, and step over it.
      gaps.push({ atFrame: frames, frames: span.lost });
      for (let i = 0; i < span.lost; i++) file.push(0);
      frames += span.lost;
      lost += span.lost;
      read = (read + span.lost) >>> 0;
    }
    let available = span.frames;
    while (available >= (drain ? 1 : opts.chunk)) {
      const n = Math.min(available, opts.chunk);
      ringRead(data, ring.capacity, read, n, scratch);
      for (let i = 0; i < n; i++) file.push(scratch[i]);
      frames += n;
      read = (read + n) >>> 0;
      available -= n;
    }
  };

  for (let q = 0; q < opts.quanta; q++) {
    // Producer: one render quantum, never waiting for anyone.
    const w = produced % ring.capacity;
    for (let i = 0; i < QUANTUM; i++) {
      data[(w + i) % ring.capacity] = sampleAt(produced + i);
    }
    produced += QUANTUM;
    Atomics.store(ctrl, CTRL_WRITE, produced >>> 0);

    if (!started && q >= (opts.pressAt ?? 0)) {
      // Record pressed. The writer starts at a position already in the past —
      // and the pre-roll is clamped to what has actually been captured, so a
      // take started before the buffer has filled does not put silence at its
      // head and misdate its first sample.
      pressedAt = produced;
      takeStart = Math.max(0, produced - Math.min(opts.preRollFrames ?? 0, produced));
      read = takeStart >>> 0;
      started = true;
    }
    if (q % opts.every === 0 && !opts.stalls?.has(q)) consume(false);
  }
  consume(true);

  return { file, produced, takeStart, pressedAt, lost, gaps };
}

describe('a take with no stall', () => {
  it('holds every frame, in order, once', () => {
    const r = run({ capacityFrames: 48000, quanta: 500, chunk: 4096, every: 4 });
    expect(r.lost).toBe(0);
    expect(r.gaps).toEqual([]);
    expect(r.file.length).toBe(r.produced - r.takeStart);
    for (let i = 0; i < r.file.length; i++) {
      // The ring is Float32, so the comparison is against the float32 value —
      // not against the float64 the generator produced. A tolerance would hide
      // an off-by-one in the positions, which is what this is really checking.
      expect(r.file[i]).toBe(Math.fround(sampleAt(r.takeStart + i)));
    }
  });
});

describe('a take that starts with pre-roll', () => {
  it('begins exactly `preRollFrames` before the button', () => {
    const preRoll = 4800; // 100 ms
    const r = run({
      capacityFrames: 48000,
      quanta: 400,
      chunk: 4096,
      every: 4,
      preRollFrames: preRoll,
      pressAt: 200, // well after the buffer has filled
    });

    // The claim the whole feature makes: the first sample in the file is the
    // one captured `preRoll` frames before the press, and the sample at offset
    // `preRoll` is the one that was live when the button went down.
    expect(r.takeStart).toBe(r.pressedAt - preRoll);
    expect(r.file[0]).toBe(Math.fround(sampleAt(r.pressedAt - preRoll)));
    expect(r.file[preRoll]).toBe(Math.fround(sampleAt(r.pressedAt)));
    expect(r.file.length).toBe(r.produced - r.takeStart);
  });

  it('clamps to what has been captured when record comes early', () => {
    // 30 seconds of pre-roll asked for, two quanta into the session. The take
    // must start at frame 0 rather than at a negative position, and must not
    // pad the head with silence to make up the difference — that would put a
    // start time on the file that is simply untrue.
    const r = run({
      capacityFrames: 48000,
      quanta: 100,
      chunk: 4096,
      every: 4,
      preRollFrames: 30 * 48000,
      pressAt: 2,
    });
    expect(r.takeStart).toBe(0);
    expect(r.pressedAt).toBe(3 * QUANTUM);
    expect(r.file.length).toBe(r.produced);
    expect(r.file[0]).toBe(Math.fround(sampleAt(0)));
  });

  it('reads the pre-roll out of the ring as the frames just captured', () => {
    // The mechanism on its own: fill a ring past its capacity, then read the
    // last N frames back from a position behind the write pointer. This is
    // precisely what pressing record does, and there is no copy involved.
    const ring = createRing(1, 4096, 48000);
    const ctrl = ringControl(ring.sab);
    const data = ringChannel(ring.sab, 0, ring.capacity);
    const total = 10000;
    for (let i = 0; i < total; i++) data[i % ring.capacity] = sampleAt(i);
    Atomics.store(ctrl, CTRL_WRITE, total >>> 0);

    const preRoll = 3000;
    const out = new Float32Array(preRoll);
    ringRead(data, ring.capacity, (total - preRoll) >>> 0, preRoll, out);
    for (let i = 0; i < preRoll; i++) {
      expect(out[i]).toBe(Math.fround(sampleAt(total - preRoll + i)));
    }
  });
});

describe('a take through a disk stall', () => {
  // A ring of 2048 frames against a consumer that stops for 40 quanta: the
  // producer writes 5120 frames into 2048 of space, so frames are certainly
  // lost. The point is not that nothing is lost — nothing can prevent that —
  // but what the file looks like afterwards.
  const stalls = new Set(Array.from({ length: 40 }, (_, i) => 60 + i));
  const result = run({ capacityFrames: 2048, quanta: 400, chunk: 512, every: 1, stalls });

  it('loses frames, and says how many', () => {
    expect(result.lost).toBeGreaterThan(0);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.gaps.reduce((a, g) => a + g.frames, 0)).toBe(result.lost);
  });

  it('still produces a file the same length as the take', () => {
    // The whole point. Content was lost; time was not.
    expect(result.file.length).toBe(result.produced - result.takeStart);
  });

  it('puts every surviving frame back at its own position', () => {
    const gapped = (frame: number) =>
      result.gaps.some((g) => frame >= g.atFrame && frame < g.atFrame + g.frames);
    let checked = 0;
    for (let i = 0; i < result.file.length; i++) {
      if (gapped(i)) {
        expect(result.file[i]).toBe(0); // silence stands in for what was lost
        continue;
      }
      expect(result.file[i]).toBe(Math.fround(sampleAt(result.takeStart + i)));
      checked++;
    }
    // Guard the guard: a bug that made everything look gapped would pass the
    // loop above while checking nothing.
    expect(checked).toBeGreaterThan(result.file.length * 0.8);
  });
});

describe('a ring sized the way the app sizes one', () => {
  it('absorbs a stall of several seconds without losing anything', () => {
    // 8 seconds of headroom at 48 kHz — the app's default — against a consumer
    // that stops for 5 seconds. Nothing should be lost, and that is the claim
    // the headroom exists to support.
    const quanta = Math.round((15 * 48000) / QUANTUM);
    const stallFrom = Math.round((4 * 48000) / QUANTUM);
    const stallTo = Math.round((9 * 48000) / QUANTUM);
    const stalls = new Set(
      Array.from({ length: stallTo - stallFrom }, (_, i) => stallFrom + i),
    );
    const r = run({ capacityFrames: 8 * 48000, quanta, chunk: 48000, every: 1, stalls });
    expect(r.lost).toBe(0);
    expect(r.file.length).toBe(r.produced - r.takeStart);
  });
});
