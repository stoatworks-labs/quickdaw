/**
 * The lock-free ring the whole recorder is built on.
 *
 * One SharedArrayBuffer carries every captured channel. The AudioWorklet writes
 * into it on the audio thread; a Worker reads out of it and writes to disk. They
 * never block each other and they never allocate, which is the only way to make
 * the audio side's timing independent of how slow a disk decides to be.
 *
 * ## Why this shape rather than postMessage
 *
 * The obvious implementation posts each render quantum from the worklet to the
 * main thread. At 48 kHz that is 375 messages a second, each carrying one
 * Float32Array per channel — 12,000 allocations a second on a 32-channel
 * interface, every one of them garbage. The collector that eventually runs to
 * clean them up runs on a thread that is also trying to deliver audio. That is
 * precisely the "buffer instability" this app exists to avoid, and no buffer
 * size fixes it, because the problem is the allocation rate rather than the
 * buffer.
 *
 * Here the audio thread does two `set()` calls per channel per quantum into
 * memory that was allocated once, then one atomic store. No allocation, no
 * message queue, no main thread involvement at all.
 *
 * ## The contract
 *
 * Single producer, single consumer. The producer only ever increases
 * `CTRL_WRITE`; the consumer keeps its own read position and never writes to the
 * control block except to record what it observed.
 *
 * **The producer never waits.** If the consumer falls behind by more than the
 * ring holds, the producer overwrites unread frames and carries on. That is a
 * deliberate choice: a producer that waited would stall the audio thread, which
 * turns a disk hiccup into an audible glitch and, on a live recording, into
 * damage. Instead the consumer detects exactly how many frames it lost, and the
 * writer substitutes that many frames of silence so every track stays
 * sample-aligned and the take stays the right length. A hole you can see and
 * measure beats a click you cannot.
 *
 * ## Frame counters wrap
 *
 * `CTRL_WRITE` is a frame count held in an Int32 and read as unsigned, so it
 * wraps every 2^32 frames — 24.8 hours at 48 kHz. Wrapping is handled by doing
 * the subtraction in the same modulus (`(w - r) >>> 0`), which is correct across
 * the wrap without needing a 64-bit counter, and a 64-bit counter cannot be read
 * atomically here anyway. The consumer's own position is a JS number, exact well
 * past any recording anyone will make.
 */

/** Control words, in Int32 slots at the head of the buffer. */
export const CTRL_WRITE = 0;
/** Frames the producer had to drop because it had no input at all. */
export const CTRL_SILENT = 1;
/** Non-zero once the producer has seen its first quantum. */
export const CTRL_STARTED = 2;
/** Channels the producer is actually writing. Set once, before it starts. */
export const CTRL_CHANNELS = 3;
/** Ring capacity in frames. Set once, before it starts. */
export const CTRL_CAPACITY = 4;

/**
 * Int32 slots reserved at the head. Larger than the five in use so a later
 * counter can be added without changing the byte offset of the audio, which
 * would silently reinterpret every existing buffer.
 */
export const CTRL_WORDS = 16;

/** Byte offset of the audio data. Float32 alignment is satisfied by CTRL_WORDS. */
export const AUDIO_OFFSET = CTRL_WORDS * 4;

export interface RingLayout {
  sab: SharedArrayBuffer;
  channels: number;
  /** Frames per channel. */
  capacity: number;
  sampleRate: number;
}

/**
 * Bytes a ring of this shape needs.
 *
 * Planar, not interleaved: each channel is a contiguous run of `capacity`
 * floats. The consumer pulls one channel at a time to write one file per track,
 * so planar makes every copy a straight `subarray`, and the producer's per-
 * channel `set()` is contiguous too. Interleaving would make both sides stride.
 */
export function ringBytes(channels: number, capacity: number): number {
  return AUDIO_OFFSET + channels * capacity * 4;
}

/**
 * Allocate a ring.
 *
 * `capacity` is rounded up to a whole number of render quanta so the producer's
 * wrap arithmetic can never split a quantum across the seam in a way that
 * leaves a partial frame — it can still split it, but only on a frame boundary.
 */
export function createRing(channels: number, frames: number, sampleRate: number): RingLayout {
  const capacity = Math.ceil(frames / 128) * 128;
  const sab = new SharedArrayBuffer(ringBytes(channels, capacity));
  const ctrl = new Int32Array(sab, 0, CTRL_WORDS);
  Atomics.store(ctrl, CTRL_CHANNELS, channels);
  Atomics.store(ctrl, CTRL_CAPACITY, capacity);
  return { sab, channels, capacity, sampleRate };
}

/** The control words of a ring, as an Int32Array view. */
export function ringControl(sab: SharedArrayBuffer): Int32Array {
  return new Int32Array(sab, 0, CTRL_WORDS);
}

/** One channel's storage, as a Float32Array view. Never copies. */
export function ringChannel(sab: SharedArrayBuffer, channel: number, capacity: number): Float32Array {
  return new Float32Array(sab, AUDIO_OFFSET + channel * capacity * 4, capacity);
}

/** Total frames written, as an unsigned count modulo 2^32. */
export function ringWritePosition(ctrl: Int32Array): number {
  return Atomics.load(ctrl, CTRL_WRITE) >>> 0;
}

export interface RingSpan {
  /** Frames the consumer may read, starting at its own read position. */
  frames: number;
  /** Frames irrecoverably overwritten before the readable span. */
  lost: number;
}

/**
 * What a consumer at `read` can take right now.
 *
 * `read` is the consumer's own total-frames-consumed count. Both it and the
 * producer's counter are reduced mod 2^32 before subtracting, which is what
 * makes this correct across the producer's wrap.
 */
export function ringAvailable(ctrl: Int32Array, capacity: number, read: number): RingSpan {
  const w = ringWritePosition(ctrl);
  const available = (w - (read >>> 0)) >>> 0;
  if (available <= capacity) return { frames: available, lost: 0 };
  // The producer lapped us. Everything older than the last `capacity` frames is
  // gone; say exactly how much so the writer can pad the hole.
  return { frames: capacity, lost: available - capacity };
}

/**
 * Copy `frames` frames of one channel out of the ring into `out`.
 *
 * The ring is read by absolute frame position, so a span that crosses the seam
 * comes out as two contiguous copies rather than a per-sample loop. `out` must
 * hold at least `frames`.
 */
export function ringRead(
  data: Float32Array,
  capacity: number,
  from: number,
  frames: number,
  out: Float32Array,
): void {
  const start = ((from % capacity) + capacity) % capacity;
  const first = Math.min(frames, capacity - start);
  out.set(data.subarray(start, start + first), 0);
  if (first < frames) out.set(data.subarray(0, frames - first), first);
}

/**
 * Turn the producer's wrapping 32-bit position into an absolute frame count.
 *
 * `previous` is the last absolute value this caller derived. As long as it is
 * called more often than the counter wraps — 24.8 hours at 48 kHz, against a
 * caller that runs four times a second — each wrap is detected as the low word
 * going backwards, and the absolute count stays exact into the thousands of
 * years a float64 integer covers.
 *
 * Only the pre-roll clamp needs this. Everything else compares positions inside
 * the same modulus, where the wrap takes care of itself.
 */
export function unwrapPosition(previous: number, wrapped: number): number {
  const low = previous >>> 0;
  const delta = (wrapped - low) >>> 0;
  return previous + delta;
}

/**
 * The consumer's published position, and the run flag — the playback direction.
 *
 * Recording and playback use the same ring in opposite directions. Capture has
 * a producer that must never wait, so the consumer's position is private to it
 * and the producer overwrites when lapped. Playback is the mirror: the consumer
 * is the audio thread and it is the one that must never wait, so here the
 * consumer publishes where it has got to and the *producer* is the side that
 * has to keep out of its way.
 *
 * `CTRL_RUN` lets the main thread hold the consumer still without tearing the
 * graph down, which is what makes a seek safe: stop consuming, refill from the
 * new position, start consuming again. Without it a seek races the audio thread
 * and plays a frame or two of whatever was left over from before the jump.
 */
export const CTRL_READ = 5;
export const CTRL_RUN = 6;

/** The consumer's position, as an unsigned count modulo 2^32. */
export function ringReadPosition(ctrl: Int32Array): number {
  return Atomics.load(ctrl, CTRL_READ) >>> 0;
}

/**
 * Frames a producer may write without overwriting anything unconsumed.
 *
 * One frame is left unused so a completely full ring is distinguishable from a
 * completely empty one — with both positions equal in either case, there is
 * otherwise no way to tell them apart, and guessing wrong means either
 * discarding a ring's worth of audio or playing it twice.
 */
export function ringFree(ctrl: Int32Array, capacity: number): number {
  const w = ringWritePosition(ctrl);
  const r = ringReadPosition(ctrl);
  return capacity - ((w - r) >>> 0) - 1;
}

/** Reset both positions. Only safe while `CTRL_RUN` is 0. */
export function ringRewind(ctrl: Int32Array): void {
  Atomics.store(ctrl, CTRL_READ, 0);
  Atomics.store(ctrl, CTRL_WRITE, 0);
  Atomics.store(ctrl, CTRL_SILENT, 0);
}

/**
 * Copy `frames` into one channel of the ring at an absolute position.
 *
 * The write side of `ringRead`, and split at the seam the same way.
 */
export function ringWrite(
  data: Float32Array,
  capacity: number,
  at: number,
  frames: number,
  source: Float32Array,
): void {
  const start = ((at % capacity) + capacity) % capacity;
  const first = Math.min(frames, capacity - start);
  data.set(source.subarray(0, first), start);
  if (first < frames) data.set(source.subarray(first, frames), 0);
}
