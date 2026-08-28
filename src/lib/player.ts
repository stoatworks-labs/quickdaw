/**
 * Playback of a take: the reader, the ring, the mixer worklet, and a transport.
 *
 * The recorder's shape, run backwards. The same ring module, the same rule
 * about which side is allowed to wait (here it is the reader, never the audio
 * thread), and the same refusal to hold a take in memory — a forty-minute
 * sixteen-track take is several gigabytes, and `decodeAudioData` would want all
 * of it before the first sample played.
 *
 * ## The playhead comes from the audio thread
 *
 * Not from a timer, and not from `AudioContext.currentTime`. The worklet
 * publishes how many frames it has actually consumed, so the position on screen
 * is the position that has been played — it cannot drift, and if the reader
 * ever fails to keep up the playhead slows down with the audio rather than
 * running away from it.
 */

import {
  AUDIO_OFFSET,
  CTRL_RUN,
  CTRL_SILENT,
  CTRL_READ,
  CTRL_WRITE,
  CTRL_WORDS,
  createRing,
  ringControl,
  ringReadPosition,
  unwrapPosition,
} from './ring';
import { mixCoefficients } from './mix';
import type { FromReader, LoadMessage } from '../workers/reader';
import type { TakeManifest, Track } from '../types';

const WORKLET_URL = new URL('playback-worklet.js', document.baseURI).href;

/** Seconds of audio held ahead of the playhead. */
const RING_SECONDS = 4;

export type PlayerStatus = 'empty' | 'loading' | 'ready' | 'playing' | 'error';

type Listener = () => void;

export class Player {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private worker: Worker | null = null;
  private ctrl: Int32Array | null = null;
  private scope = new Float32Array(2048);

  /** Frame the ring's own zero corresponds to. Set by every seek. */
  private base = 0;
  private consumed = 0;

  status: PlayerStatus = 'empty';
  take: TakeManifest | null = null;
  lastError: string | null = null;

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  get frames(): number {
    return this.take?.frames ?? 0;
  }

  get sampleRate(): number {
    return this.take?.sampleRate ?? 48000;
  }

  /** The playhead, in frames. Read it every animation frame; it is two loads. */
  position(): number {
    if (!this.ctrl) return 0;
    this.consumed = unwrapPosition(this.consumed, ringReadPosition(this.ctrl));
    return Math.min(this.frames, this.base + this.consumed);
  }

  /** Frames the worklet had to invent because the reader was behind. */
  underruns(): number {
    return this.ctrl ? Atomics.load(this.ctrl, CTRL_SILENT) : 0;
  }

  /** Peak of the stereo output since the last call, linear. */
  outputPeak(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.scope);
    let peak = 0;
    for (let i = 0; i < this.scope.length; i++) {
      const a = Math.abs(this.scope[i]);
      if (a > peak) peak = a;
    }
    return peak;
  }

  async load(take: TakeManifest, folder: FileSystemDirectoryHandle): Promise<void> {
    await this.unload();
    this.status = 'loading';
    this.take = take;
    this.lastError = null;
    this.changed();

    try {
      const files: FileSystemFileHandle[] = [];
      for (const t of take.tracks) files.push(await folder.getFileHandle(t.file));

      const ctx = new AudioContext({ sampleRate: take.sampleRate, latencyHint: 'playback' });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(WORKLET_URL);

      const channels = take.tracks.length;
      const ring = createRing(channels, RING_SECONDS * take.sampleRate, take.sampleRate);
      this.ctrl = ringControl(ring.sab);

      const node = new AudioWorkletNode(ctx, 'quickdaw-playback', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          sab: ring.sab,
          channels,
          capacity: ring.capacity,
          audioOffset: AUDIO_OFFSET,
          ctrlWords: CTRL_WORDS,
          ctrlWrite: CTRL_WRITE,
          ctrlRead: CTRL_READ,
          ctrlRun: CTRL_RUN,
          ctrlSilent: CTRL_SILENT,
        },
      });
      this.node = node;

      const master = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      node.connect(master).connect(analyser).connect(ctx.destination);
      this.master = master;
      this.analyser = analyser;

      const worker = new Worker(new URL('../workers/reader.ts', import.meta.url), {
        type: 'module',
        name: 'quickdaw-reader',
      });
      this.worker = worker;
      worker.onmessage = (e: MessageEvent<FromReader>) => this.fromReader(e.data);

      const load: LoadMessage = {
        type: 'load',
        sab: ring.sab,
        capacity: ring.capacity,
        format: take.format,
        frames: take.frames,
        files,
      };
      worker.postMessage(load);
      this.base = 0;
      this.consumed = 0;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.status = 'error';
      this.changed();
    }
  }

  async unload(): Promise<void> {
    this.worker?.postMessage({ type: 'close' });
    this.worker?.terminate();
    this.node?.port.postMessage({ type: 'stop' });
    this.node?.disconnect();
    this.master?.disconnect();
    this.analyser?.disconnect();
    await this.ctx?.close().catch(() => {});
    this.worker = null;
    this.node = null;
    this.master = null;
    this.analyser = null;
    this.ctx = null;
    this.ctrl = null;
    this.take = null;
    this.base = 0;
    this.consumed = 0;
    this.status = 'empty';
    this.changed();
  }

  async play(): Promise<void> {
    if (!this.worker || !this.ctx) return;
    // A context created before any gesture starts suspended, and a suspended
    // context runs no worklets — the transport would look like it was playing
    // and nothing would come out.
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.worker.postMessage({ type: 'play' });
    this.status = 'playing';
    this.changed();
  }

  pause(): void {
    this.worker?.postMessage({ type: 'pause' });
    if (this.status === 'playing') this.status = 'ready';
    this.changed();
  }

  seek(frame: number): void {
    if (!this.worker || !this.ctrl) return;
    // The base moves as soon as the seek is sent rather than when the worker
    // confirms it, so the playhead lands where it was dragged instead of
    // snapping back for the fraction of a second the round trip takes.
    this.base = Math.max(0, Math.min(Math.round(frame), this.frames));
    this.consumed = 0;
    this.worker.postMessage({ type: 'seek', frame: this.base });
    this.changed();
  }

  setMasterGain(db: number): void {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.02);
  }

  /**
   * Push the mix down to the worklet.
   *
   * Collapsed to coefficients on a change rather than evaluated per sample in
   * the processor. The rules live in `mix.ts`, where they can be tested.
   */
  setMix(tracks: Track[]): void {
    if (!this.node || !this.take) return;
    const { left, right } = mixCoefficients(
      this.take.tracks.map((t) => t.input),
      tracks,
    );
    this.node.port.postMessage({ type: 'mix', left, right });
  }

  private fromReader(msg: FromReader): void {
    if (msg.type === 'ready') {
      this.status = 'ready';
      this.changed();
    } else if (msg.type === 'base') {
      this.base = msg.frame;
      this.consumed = 0;
    } else if (msg.type === 'ended') {
      this.status = 'ready';
      this.changed();
    } else if (msg.type === 'error') {
      this.lastError = msg.message;
      this.status = 'error';
      this.changed();
    }
  }
}

export const player = new Player();
