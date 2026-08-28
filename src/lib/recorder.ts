/**
 * The recorder. Audio graph, ring, meters, and the writer's other end.
 *
 * Deliberately outside React, in the same way and for the same reason as the
 * rest of the fleet's audio apps: meters move at the display rate on however
 * many channels the interface has, and pushing that through component state
 * would spend a core on reconciliation for a picture nobody is looking at
 * closely. Components read the engine's buffers inside `requestAnimationFrame`.
 * React is told only about structural changes — a device opening, a take
 * starting, an error.
 *
 * ## The pre-roll is not a separate buffer
 *
 * The obvious implementation of a pre-roll keeps its own ring, and on record
 * copies it into the file before switching to the live path. That copy is a
 * burst of hundreds of megabytes on the thread that is also meant to be keeping
 * up with live audio, at the exact moment the take starts.
 *
 * There is no copy here. The pre-roll and the write buffer are one ring, and
 * pressing record simply starts the writer at a read position that is already
 * `preRollSeconds` in the past. It then chases the producer forward as it would
 * have anyway — through the pre-roll first, because that is what is in front of
 * it, and out into live audio when it catches up. Arming costs nothing, and
 * turning the pre-roll off is only a smaller ring.
 *
 * ## Why the sample rate is not chosen
 *
 * The AudioContext is created at whatever rate the device reported. Ask for any
 * other and the browser puts a resampler in front of every sample before the
 * recorder sees it — quality spent for nothing, since the take is going to a
 * file rather than to a converter with an opinion. `mismatch` is set if the
 * browser gave us a context at a different rate anyway, which it may.
 */

import {
  CTRL_CHANNELS,
  CTRL_SILENT,
  CTRL_STARTED,
  CTRL_WRITE,
  CTRL_WORDS,
  AUDIO_OFFSET,
  createRing,
  ringControl,
  ringWritePosition,
  unwrapPosition,
  type RingLayout,
} from './ring';
import { TEST_DEVICE_ID, closeStream, describeProcessing, openDevice, probeDevice } from './devices';
import { TEST_CHANNELS, createTestSource, type TestSource } from './testsignal';
import { takeFolderName } from './storage';
import type { FromWriter, StartMessage } from '../workers/writer';
import {
  EMPTY_HEALTH,
  WRITE_HEADROOM_SECONDS,
  type BufferHealth,
  type DeviceInfo,
  type EngineStatus,
  type Level,
  type SampleFormat,
  type TakeManifest,
  type Track,
} from '../types';

const WORKLET_URL = new URL('capture-worklet.js', document.baseURI).href;

/**
 * How long to wait for a suspended context to start before carrying on.
 *
 * Generous, because a slow machine opening a device is not the case this is
 * guarding against — a promise that never settles is.
 */
const RESUME_TIMEOUT_MS = 2500;

/** Interactions that count as activation, for the one-shot resume. */
const GESTURES = ['pointerdown', 'keydown', 'touchstart'] as const;

/** Below this the meter reads "off the bottom" rather than a huge negative. */
export const SILENCE_DB = -120;

export function toDb(linear: number): number {
  return linear > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(linear)) : SILENCE_DB;
}

/**
 * Whether this page can use a SharedArrayBuffer.
 *
 * The whole design rests on one: without it the only route from the audio
 * thread is postMessage, which allocates per quantum per channel and reintroduces
 * exactly the instability the app exists to avoid. Rather than ship a silently
 * worse fallback, the app says plainly that it cannot run.
 *
 * The deployed site sets the two headers that grant it (`public/_headers`), and
 * the dev and preview servers set the same pair, so this only fails when the
 * built output is served by something else — opening `dist/index.html` from the
 * filesystem, or a static server that does not know about the headers.
 */
export function isolationAvailable(): boolean {
  return typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true;
}

export interface EngineInfo {
  device: DeviceInfo | null;
  channels: number;
  sampleRate: number;
  /** Context rate, if the browser did not honour the device's. */
  contextRate: number;
  /** Processing constraints the browser declined to switch off. */
  ignored: string[];
  /** Ring size in frames, and what that is in bytes. */
  ringFrames: number;
  ringBytes: number;
  preRollFrames: number;
  /** Input latency the browser reports, in seconds. Informational. */
  baseLatency: number;
}

const EMPTY_INFO: EngineInfo = {
  device: null,
  channels: 0,
  sampleRate: 0,
  contextRate: 0,
  ignored: [],
  ringFrames: 0,
  ringBytes: 0,
  preRollFrames: 0,
  baseLatency: 0,
};

type Listener = () => void;

export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: AudioNode | null = null;
  private sink: GainNode | null = null;
  private monitorGain: GainNode | null = null;
  private worker: Worker | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private test: TestSource | null = null;

  private ring: RingLayout | null = null;
  private ctrl: Int32Array | null = null;
  private meterSab: SharedArrayBuffer | null = null;
  private clips: Int32Array | null = null;
  private meters: Float32Array | null = null;

  /** Absolute frames the producer has written since the graph started. */
  private absWrite = 0;

  /**
   * True while the audio is built but silent, waiting for a user gesture.
   *
   * Not an error: everything is connected and one click away from running.
   */
  needsGesture = false;

  status: EngineStatus = 'idle';
  info: EngineInfo = EMPTY_INFO;
  health: BufferHealth = EMPTY_HEALTH;
  lastError: string | null = null;
  /** Set once a take has been written. The newest first. */
  takes: TakeManifest[] = [];
  /** Wall-clock time the current take's first sample was captured. */
  takeStartedAt: number | null = null;
  takeFrames = 0;

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  get channels(): number {
    return this.info.channels;
  }

  // ---------------------------------------------------------------- devices

  async probe(deviceId: string): Promise<DeviceInfo> {
    return probeDevice(deviceId);
  }

  /**
   * Open a device and start capturing into the ring.
   *
   * Capture starts immediately and runs until the device is closed. That is
   * what makes the pre-roll free: there is no armed state to enter, only a ring
   * that is always being filled and a writer that has not been told to read it
   * yet.
   */
  async open(deviceId: string, preRollSeconds: number, monitorDb: number, monitor: boolean): Promise<void> {
    if (!isolationAvailable()) {
      this.fail(
        'this page is not cross-origin isolated, so it cannot allocate the shared buffer ' +
          'the recorder is built on',
      );
      return;
    }

    await this.close();
    this.status = 'opening';
    this.lastError = null;
    this.changed();

    try {
      const probed = await probeDevice(deviceId);
      // The context takes the device's own rate so nothing is resampled on the
      // way in, and 'playback' asks for the largest buffers the browser will
      // give. Nothing here is waiting on the input, so a large buffer is pure
      // margin: it is the single most effective thing available against a
      // scheduling hiccup becoming a hole in the take.
      const ctx = new AudioContext({
        sampleRate: probed.sampleRate || undefined,
        latencyHint: 'playback',
      });
      this.ctx = ctx;
      await this.startContext(ctx);
      await ctx.audioWorklet.addModule(WORKLET_URL);

      // Two ways in, and everything downstream of here is identical for both.
      // The generated source is not a mock of the capture path — it is a real
      // AudioNode feeding the real worklet, so a take made from it exercises
      // the ring, the writer and the files exactly as a live interface does.
      let source: AudioNode;
      let channels: number;
      let ignored: string[] = [];
      let track: MediaStreamTrack | null = null;

      if (deviceId === TEST_DEVICE_ID) {
        const test = createTestSource(ctx);
        this.test = test;
        source = test.node;
        channels = TEST_CHANNELS;
      } else {
        const open = await openDevice(deviceId, probed.channels || 2);
        this.stream = open.stream;
        track = open.track;
        source = ctx.createMediaStreamSource(open.stream);
        // The track's own setting is the authority, and `source.channelCount`
        // is NOT a second opinion on it — for a source node it is an *input*-
        // side mixing property, and a source node has no inputs. On a
        // MediaStreamAudioSourceNode it reads 2 no matter how many channels the
        // stream actually carries, so clamping to it silently caps every
        // interface at two inputs. (A ChannelMergerNode makes the same point
        // loudly: its channelCount is fixed at 1 while its output has as many
        // channels as it has inputs.)
        channels = Math.max(1, open.channels);
        ignored = describeProcessing(open.track);
      }
      this.source = source;

      const frames = Math.round((preRollSeconds + WRITE_HEADROOM_SECONDS) * ctx.sampleRate);
      const ring = createRing(channels, frames, ctx.sampleRate);
      this.ring = ring;
      this.ctrl = ringControl(ring.sab);

      // Meters: the clip counters first so the float block after them is still
      // 4-byte aligned, which a Float32Array view requires.
      this.meterSab = new SharedArrayBuffer(channels * 4 + channels * 3 * 4);
      this.clips = new Int32Array(this.meterSab, 0, channels);
      this.meters = new Float32Array(this.meterSab, channels * 4, channels * 3);

      const node = new AudioWorkletNode(ctx, 'quickdaw-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [channels],
        // 'discrete' is the one that matters. The default, 'speakers', applies
        // the up/down-mix rules — which for anything above two channels means
        // the browser helpfully folding a 16-input interface into a surround
        // layout and handing the worklet a mix rather than the inputs.
        channelCount: channels,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
        processorOptions: {
          sab: ring.sab,
          meterSab: this.meterSab,
          channels,
          capacity: ring.capacity,
          audioOffset: AUDIO_OFFSET,
          ctrlWords: CTRL_WORDS,
          ctrlWrite: CTRL_WRITE,
          ctrlSilent: CTRL_SILENT,
          ctrlStarted: CTRL_STARTED,
        },
      });
      this.node = node;
      source.connect(node);

      // A worklet with no path to the destination is not guaranteed to be
      // pulled at all. The silent sink keeps the graph alive without putting
      // captured audio back out of the speakers, which on an open microphone
      // is a feedback loop.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink).connect(ctx.destination);
      this.sink = sink;

      const mon = ctx.createGain();
      mon.gain.value = monitor ? Math.pow(10, monitorDb / 20) : 0;
      node.connect(mon).connect(ctx.destination);
      this.monitorGain = mon;

      this.absWrite = 0;
      this.info = {
        device: probed,
        channels,
        sampleRate: ctx.sampleRate,
        contextRate: ctx.sampleRate,
        ignored,
        ringFrames: ring.capacity,
        ringBytes: AUDIO_OFFSET + channels * ring.capacity * 4,
        preRollFrames: Math.round(preRollSeconds * ctx.sampleRate),
        baseLatency: ctx.baseLatency ?? 0,
      };
      if (probed.sampleRate && probed.sampleRate !== ctx.sampleRate) {
        this.info.sampleRate = probed.sampleRate;
      }

      // An interface unplugged mid-take ends the track rather than erroring.
      // Without this the recording quietly becomes silence. The generated
      // source has no track and cannot go away.
      track?.addEventListener('ended', () => {
        if (this.status === 'recording') void this.stop();
        this.fail('the audio device went away');
      });

      this.status = 'monitoring';
      this.changed();
    } catch (err) {
      await this.close();
      this.fail(describe(err));
    }
  }

  /**
   * Get the context running, without being able to hang on it.
   *
   * A browser will not start an AudioContext without a user gesture, and
   * Chrome's way of saying so is not to reject — `resume()` returns a promise
   * that simply **never settles** until activation arrives. Awaiting it bare
   * means `open()` never returns, the UI sits on "Opening the device…" for ever,
   * and nothing is logged, thrown or reported. It is the worst shape a failure
   * can have.
   *
   * So the wait is bounded. If the context has not started, the graph is built
   * anyway — it is perfectly valid, just silent — and a one-shot listener
   * resumes it on the next real interaction, which is the only thing that can.
   * The caller is told, so the UI can say what is needed rather than looking
   * broken.
   */
  private async startContext(ctx: AudioContext): Promise<void> {
    if (ctx.state !== 'suspended') return;
    const started = await Promise.race([
      ctx.resume().then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), RESUME_TIMEOUT_MS)),
    ]);
    if (started || ctx.state !== 'suspended') return;

    this.needsGesture = true;
    const wake = () => {
      void ctx.resume().then(() => {
        this.needsGesture = false;
        this.changed();
      });
      for (const e of GESTURES) window.removeEventListener(e, wake);
    };
    for (const e of GESTURES) window.addEventListener(e, wake, { once: true });
  }

  async close(): Promise<void> {
    if (this.status === 'recording') await this.stop();
    this.node?.port.postMessage('stop');
    this.test?.stop();
    this.test = null;
    this.node?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.monitorGain?.disconnect();
    closeStream(this.stream);
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.sink = null;
    this.monitorGain = null;
    this.ring = null;
    this.ctrl = null;
    this.meters = null;
    this.clips = null;
    this.meterSab = null;
    this.info = EMPTY_INFO;
    this.needsGesture = false;
    if (this.status !== 'error') this.status = 'idle';
    this.changed();
  }

  setMonitor(on: boolean, db: number): void {
    if (!this.monitorGain || !this.ctx) return;
    const target = on ? Math.pow(10, db / 20) : 0;
    // Ramped, not stepped. A gain that jumps is a click, and on a monitor path
    // that click goes out of the speakers at whatever the new level is.
    this.monitorGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  // ----------------------------------------------------------------- meters

  /** Read the current level of one channel. Cheap; call it per frame. */
  level(channel: number, out: Level): Level {
    const m = this.meters;
    const n = this.info.channels;
    if (!m || channel >= n) {
      out.peakDb = out.rmsDb = out.holdDb = SILENCE_DB;
      out.clipped = false;
      return out;
    }
    out.peakDb = toDb(m[channel]);
    out.rmsDb = toDb(m[n + channel]);
    out.holdDb = toDb(m[n * 2 + channel]);
    out.clipped = (this.clips?.[channel] ?? 0) > 0;
    return out;
  }

  /**
   * Bumped whenever the clip indicators are cleared.
   *
   * The indicators latch and are drawn straight into the DOM by the meter loop,
   * which never unsets them — a latch that something else can quietly drop is
   * not a latch. This counter is how the loop is told that a *person* cleared
   * them, without the level path having to go through React.
   */
  clipGeneration = 0;

  clearClips(): void {
    this.clipGeneration++;
    if (!this.clips) return;
    for (let i = 0; i < this.clips.length; i++) Atomics.store(this.clips, i, 0);
  }

  /**
   * Frames captured since the device opened.
   *
   * Also the ceiling on how much pre-roll actually exists: a take started ten
   * seconds after opening the device has ten seconds of pre-roll available
   * however many were asked for, and claiming otherwise would put silence at
   * the head of the file and misdate its first sample.
   */
  framesSinceOpen(): number {
    if (!this.ctrl) return 0;
    this.absWrite = unwrapPosition(this.absWrite, ringWritePosition(this.ctrl));
    return this.absWrite;
  }

  /** Frames the producer had to invent because the input went away. */
  silentFrames(): number {
    return this.ctrl ? Atomics.load(this.ctrl, CTRL_SILENT) : 0;
  }

  private capturing(): boolean {
    return !!this.ctrl && Atomics.load(this.ctrl, CTRL_STARTED) === 1;
  }

  // ---------------------------------------------------------------- takes

  /**
   * Start writing a take.
   *
   * `preRoll` is in frames and is clamped twice — to what the ring physically
   * holds, and to what has actually been captured since the device opened.
   */
  async record(options: {
    directory: FileSystemDirectoryHandle;
    tracks: Track[];
    format: SampleFormat;
    preRollFrames: number;
    keepAwake: boolean;
  }): Promise<void> {
    if (!this.ring || !this.ctrl || this.status !== 'monitoring') return;
    if (!this.capturing()) {
      this.fail('no audio has arrived from the device yet');
      return;
    }
    const armed = options.tracks.filter((t) => t.armed);
    if (armed.length === 0) {
      this.fail('no tracks are armed');
      return;
    }

    const rate = this.ring.sampleRate;
    // Leave the write headroom out of the pre-roll: the writer needs somewhere
    // to fall behind into, and a pre-roll that consumed the entire ring would
    // start the take already at the point of overrun.
    const usable = this.ring.capacity - Math.round(WRITE_HEADROOM_SECONDS * rate);
    const preRoll = Math.max(
      0,
      Math.min(options.preRollFrames, usable, this.framesSinceOpen()),
    );

    const now = ringWritePosition(this.ctrl);
    const startRead = (now - preRoll) >>> 0;
    const startedAt = new Date(Date.now() - (preRoll / rate) * 1000);

    this.health = { ...EMPTY_HEALTH };
    this.takeFrames = 0;
    this.takeStartedAt = startedAt.getTime();

    const worker = new Worker(new URL('../workers/writer.ts', import.meta.url), {
      type: 'module',
      name: 'quickdaw-writer',
    });
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<FromWriter>) => this.fromWriter(e.data);

    const start: StartMessage = {
      type: 'start',
      sab: this.ring.sab,
      capacity: this.ring.capacity,
      sampleRate: rate,
      format: options.format,
      startRead,
      preRollFrames: preRoll,
      tracks: armed.map((t) => ({ input: t.input, name: t.name })),
      directory: options.directory,
      folderName: takeFolderName(startedAt),
      startedAt: startedAt.toISOString(),
      device: this.info.device?.label ?? 'unknown device',
    };
    worker.postMessage(start);

    this.status = 'recording';
    this.changed();
    if (options.keepAwake) void this.acquireWakeLock();
  }

  async stop(): Promise<void> {
    if (!this.worker || this.status !== 'recording') return;
    this.status = 'stopping';
    this.changed();
    const worker = this.worker;
    await new Promise<void>((resolve) => {
      const done = (e: MessageEvent<FromWriter>) => {
        if (e.data.type === 'done' || e.data.type === 'error') {
          worker.removeEventListener('message', done);
          resolve();
        }
      };
      worker.addEventListener('message', done);
      worker.postMessage({ type: 'stop' });
      // A writer that never answers must not leave the transport stuck. The
      // files are the worker's problem; the UI's job is to come back.
      setTimeout(resolve, 15000);
    });
    worker.terminate();
    this.worker = null;
    this.releaseWakeLock();
    if (this.status === 'stopping') this.status = this.ctx ? 'monitoring' : 'idle';
    this.changed();
  }

  private fromWriter(msg: FromWriter): void {
    if (msg.type === 'health') {
      this.health = {
        fill: msg.fill,
        worstFill: msg.worstFill,
        dropped: msg.dropped,
        worstWriteMs: msg.worstWriteMs,
        bytes: msg.bytes,
      };
      this.takeFrames = msg.frames;
      // Health is polled by the UI on its own clock; a listener call four times
      // a second per take would re-render the whole app for a number that a
      // canvas is already drawing.
      return;
    }
    if (msg.type === 'done') {
      this.takes = [msg.manifest, ...this.takes];
      this.changed();
      return;
    }
    if (msg.type === 'error') {
      this.lastError = msg.message;
      this.changed();
    }
  }

  // -------------------------------------------------------------- wake lock

  /**
   * Keep the machine awake for the length of a take.
   *
   * A screen that sleeps mid-recording throttles timers on the page, and a
   * machine that suspends stops the audio device outright. The lock is released
   * at stop rather than held, and re-taken if the tab is hidden and shown
   * again, which is when the browser drops it on its own.
   */
  private async acquireWakeLock(): Promise<void> {
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
      this.wakeLock?.addEventListener('release', () => {
        if (this.status === 'recording' && document.visibilityState === 'visible') {
          void this.acquireWakeLock();
        }
      });
    } catch {
      // Denied, unsupported, or the tab was not visible. Not worth surfacing:
      // nothing about the recording depends on it, and there is nothing the
      // user could do in response.
    }
  }

  private releaseWakeLock(): void {
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  private fail(message: string): void {
    this.lastError = message;
    this.status = 'error';
    this.changed();
  }
}

function describe(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'permission to use the audio device was refused';
    if (err.name === 'NotFoundError') return 'that audio device is no longer connected';
    if (err.name === 'NotReadableError') {
      return 'the device is open in another application and will not open twice';
    }
    if (err.name === 'OverconstrainedError') {
      return 'the device would not open at the requested channel count';
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** One engine, module-level, in the shape the rest of the fleet's apps use. */
export const recorder = new Recorder();

export { CTRL_CHANNELS };
