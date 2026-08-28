/**
 * The capture processor. Runs on the audio thread; owns the write side of the
 * ring and the meters.
 *
 * Plain JavaScript on purpose: this file is loaded by URL through
 * `audioWorklet.addModule()` and is never bundled, so nothing here may use
 * TypeScript syntax, imports, or anything the browser will not run as-is.
 *
 * ## What it may not do
 *
 * Allocate, post a message on the audio path, or take a lock. Every buffer it
 * touches was allocated before it started, every write into the ring is a
 * `set()` into shared memory, and the only synchronisation is one atomic store
 * at the end of each quantum. That is the whole reason the recorder's timing
 * does not depend on the disk, the main thread, or the garbage collector.
 *
 * ## Time never stops
 *
 * If the input goes away — an interface unplugged mid-take, a stream ended by
 * the browser — `inputs[0]` arrives empty. The processor still advances the
 * write pointer by a full quantum of silence and counts the frames in
 * `CTRL_SILENT`. Not advancing would be the worse bug by far: the recording
 * would simply omit the missing time, so every track would end up shorter than
 * the take and everything after the interruption would sit early. Silence of
 * exactly the right length keeps the take honest, and the counter says it
 * happened.
 *
 * The layout constants arrive in `processorOptions` rather than being repeated
 * here, so there is one definition of the ring's shape (src/lib/ring.ts) and no
 * way for this file to drift out of agreement with it.
 */

const CLIP_THRESHOLD = 0.999;

/** Peak and hold fall at 20 dB/s once the signal has gone, as a PPM does. */
const FALL_DB_PER_SECOND = 20;
/** Peak hold sits still for this long before it starts to fall. */
const HOLD_SECONDS = 2;
/** RMS averaging time constant. 300 ms is the usual studio figure. */
const RMS_TAU = 0.3;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;

    this.channels = o.channels;
    this.capacity = o.capacity;
    this.ctrl = new Int32Array(o.sab, 0, o.ctrlWords);
    this.ctrlWrite = o.ctrlWrite;
    this.ctrlSilent = o.ctrlSilent;
    this.ctrlStarted = o.ctrlStarted;

    // One view per channel, made once. Each is a contiguous run of the ring.
    this.data = [];
    for (let ch = 0; ch < this.channels; ch++) {
      this.data.push(new Float32Array(o.sab, o.audioOffset + ch * this.capacity * 4, this.capacity));
    }

    // Meters live in their own small buffer: ints first so the Float32 block
    // that follows is still 4-byte aligned.
    this.clips = new Int32Array(o.meterSab, 0, this.channels);
    this.meters = new Float32Array(o.meterSab, this.channels * 4, this.channels * 3);
    this.mPeak = 0;
    this.mRms = this.channels;
    this.mHold = this.channels * 2;

    this.peak = new Float32Array(this.channels);
    this.hold = new Float32Array(this.channels);
    this.meanSq = new Float32Array(this.channels);
    this.holdAge = new Float32Array(this.channels);

    const dt = 128 / sampleRate;
    this.fall = Math.pow(10, (-FALL_DB_PER_SECOND * dt) / 20);
    this.rmsA = Math.exp(-dt / RMS_TAU);
    this.dt = dt;

    this.running = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.running = false;
    };
  }

  process(inputs) {
    if (!this.running) return false;

    const input = inputs[0];
    const supplied = input ? input.length : 0;
    // A quantum is 128 frames, but read it off the data rather than assuming:
    // the render quantum is fixed today and the spec allows it to be
    // configurable, and a hardcoded 128 would silently halve or double the
    // recording's speed if that ever changed.
    const n = supplied > 0 ? input[0].length : 128;

    const w = Atomics.load(this.ctrl, this.ctrlWrite) >>> 0;
    const start = w % this.capacity;
    const first = Math.min(n, this.capacity - start);

    for (let ch = 0; ch < this.channels; ch++) {
      const dst = this.data[ch];
      const src = ch < supplied ? input[ch] : null;
      if (src) {
        // Two contiguous copies rather than a modulo per sample. The second one
        // only exists on the quantum that straddles the ring's seam.
        dst.set(first === n ? src : src.subarray(0, first), start);
        if (first < n) dst.set(src.subarray(first, n), 0);
      } else {
        dst.fill(0, start, start + first);
        if (first < n) dst.fill(0, 0, n - first);
      }
      this.meter(ch, src, n);
    }

    if (supplied === 0) {
      Atomics.add(this.ctrl, this.ctrlSilent, n);
    }

    // Release: every write above is visible to a consumer that has done the
    // matching acquiring load of this word. Publishing the frames last is what
    // makes the pair safe without a lock.
    Atomics.store(this.ctrl, this.ctrlWrite, (w + n) >>> 0);
    Atomics.store(this.ctrl, this.ctrlStarted, 1);
    return true;
  }

  meter(ch, src, n) {
    let blockPeak = 0;
    let sumSq = 0;
    let clipped = 0;
    if (src) {
      for (let i = 0; i < n; i++) {
        const v = src[i];
        const a = v < 0 ? -v : v;
        if (a > blockPeak) blockPeak = a;
        sumSq += v * v;
        if (a >= CLIP_THRESHOLD) clipped++;
      }
    }

    let peak = this.peak[ch] * this.fall;
    if (blockPeak > peak) peak = blockPeak;
    this.peak[ch] = peak;

    // Mean square, one-pole. Smoothing the square and taking the root at the
    // end is the correct order — smoothing the root would not be an RMS.
    const ms = sumSq / n;
    this.meanSq[ch] = this.meanSq[ch] * this.rmsA + ms * (1 - this.rmsA);

    if (blockPeak >= this.hold[ch]) {
      this.hold[ch] = blockPeak;
      this.holdAge[ch] = 0;
    } else {
      this.holdAge[ch] += this.dt;
      if (this.holdAge[ch] > HOLD_SECONDS) this.hold[ch] *= this.fall;
    }

    if (clipped > 0) Atomics.add(this.clips, ch, clipped);

    // Plain stores. A reader that catches one quantum's worth of staleness on a
    // meter has seen nothing wrong; the clip counter, which must not lose a
    // count, is the atomic one above.
    this.meters[this.mPeak + ch] = peak;
    this.meters[this.mRms + ch] = Math.sqrt(this.meanSq[ch]);
    this.meters[this.mHold + ch] = this.hold[ch];
  }
}

registerProcessor('quickdaw-capture', CaptureProcessor);
