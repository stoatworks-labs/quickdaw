/**
 * The playback processor: the take's tracks out of the ring, through the
 * mixer, into two output channels.
 *
 * Plain JavaScript, loaded by URL, never bundled — the same rule as the capture
 * processor, and the layout constants arrive in `processorOptions` for the same
 * reason.
 *
 * ## The mixer is here rather than in the graph
 *
 * The obvious build gives every track its own GainNode and StereoPannerNode.
 * That is thirty-two ring readers, sixty-four nodes, and thirty-two separate
 * paths whose sample alignment depends on the graph rather than on anything
 * this code controls. Mixing inside one processor keeps all of it in one loop
 * over one buffer, and every track is by construction reading the same frame.
 *
 * ## An empty ring is silence, not a stall
 *
 * If the reader has not kept up, this fills the output with zeros, counts the
 * frames it had to invent, and carries on at the right speed. Waiting is not
 * available — the audio thread has a deadline — and repeating the last frame
 * would sound far worse than the gap it is covering.
 */

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;

    this.channels = o.channels;
    this.capacity = o.capacity;
    this.ctrl = new Int32Array(o.sab, 0, o.ctrlWords);
    this.ctrlWrite = o.ctrlWrite;
    this.ctrlRead = o.ctrlRead;
    this.ctrlRun = o.ctrlRun;
    this.ctrlSilent = o.ctrlSilent;

    this.data = [];
    for (let ch = 0; ch < this.channels; ch++) {
      this.data.push(new Float32Array(o.sab, o.audioOffset + ch * this.capacity * 4, this.capacity));
    }

    // Per-track left and right coefficients, already combining gain, pan and
    // mute/solo. The main thread does that arithmetic once per change; this
    // loop only multiplies.
    this.left = new Float32Array(this.channels);
    this.right = new Float32Array(this.channels);
    this.left.fill(0.7071);
    this.right.fill(0.7071);

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'mix') {
        this.left.set(m.left);
        this.right.set(m.right);
      } else if (m.type === 'stop') {
        this.running = false;
      }
    };
    this.running = true;
  }

  process(_inputs, outputs) {
    if (!this.running) return false;

    const out = outputs[0];
    const outL = out[0];
    // The node is built with two output channels, so this is the real second
    // one. The fallback aliases it to the first and the gains are folded to
    // mono below, so a host that gave us one channel plays a mono sum rather
    // than the left side at double level.
    const stereo = out.length > 1;
    const outR = stereo ? out[1] : outL;
    const n = outL.length;

    outL.fill(0);
    if (outR !== outL) outR.fill(0);

    if (Atomics.load(this.ctrl, this.ctrlRun) !== 1) return true;

    const w = Atomics.load(this.ctrl, this.ctrlWrite) >>> 0;
    const r = Atomics.load(this.ctrl, this.ctrlRead) >>> 0;
    const available = (w - r) >>> 0;
    const take = available < n ? available : n;
    if (take < n) Atomics.add(this.ctrl, this.ctrlSilent, n - take);
    if (take === 0) return true;

    const start = r % this.capacity;
    const first = take < this.capacity - start ? take : this.capacity - start;

    for (let ch = 0; ch < this.channels; ch++) {
      let gl = this.left[ch];
      let gr = this.right[ch];
      if (gl === 0 && gr === 0) continue; // muted, or not in the solo set
      if (!stereo) {
        gl = (gl + gr) * 0.5;
        gr = 0; // outR is outL; adding zero keeps the loop branch-free
      }
      const src = this.data[ch];
      for (let i = 0; i < first; i++) {
        const v = src[start + i];
        outL[i] += v * gl;
        outR[i] += v * gr;
      }
      for (let i = first; i < take; i++) {
        const v = src[i - first];
        outL[i] += v * gl;
        outR[i] += v * gr;
      }
    }

    // Publish last: the frames above must be read before the producer is told
    // it may overwrite them.
    Atomics.store(this.ctrl, this.ctrlRead, (r + take) >>> 0);
    return true;
  }
}

registerProcessor('quickdaw-playback', PlaybackProcessor);
