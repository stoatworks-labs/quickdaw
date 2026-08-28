/// <reference lib="webworker" />
/**
 * The disk writer. One Worker, one take, every track.
 *
 * ## Why a Worker and not the main thread
 *
 * The main thread is drawing meters at the display rate and running React. A
 * layout, a long task from an extension, or a garbage collection there is
 * routine and harmless — unless the disk writer is on it too, in which case
 * every one of those becomes a pause in the only code that is emptying the
 * ring. The audio thread never blocks either way, but the ring is finite, and a
 * long enough pause on this side is a hole in the take. Off the main thread it
 * takes something far more serious than a slow render to run late.
 *
 * ## What it does with a hole it could not avoid
 *
 * If the producer laps the reader — a disk that stalls for longer than the ring
 * holds — the frames are gone and no amount of care gets them back. What this
 * writer does *not* do is carry on writing the frames that survived as if
 * nothing happened. That would shorten every track by the size of the hole and
 * pull everything after it early, and because the shortening is identical on
 * every track the result stays perfectly in sync with itself while being wrong
 * against the world — the failure that is impossible to spot afterwards.
 *
 * Instead the gap is padded with exactly as many frames of silence as were
 * lost, and its position and length go into `take.json`. The take keeps its
 * length, everything after the gap sits where it belongs, and the gap is a
 * documented fact rather than a mystery.
 *
 * ## Every track advances together
 *
 * All tracks are written from the same read position, one chunk at a time,
 * before the position advances. There is no per-track cursor that could drift,
 * so tracks cannot lose alignment with each other however slowly one file's
 * writes come back.
 */

import { ringAvailable, ringChannel, ringControl, ringRead } from '../lib/ring';
import {
  RIFF_LIMIT,
  encode,
  frameBytes,
  sizePatches,
  wavHeader,
  type SampleFormat,
} from '../lib/wav';
import { trackFileName } from '../lib/storage';
import type { Gap, TakeManifest } from '../types';

export interface StartMessage {
  type: 'start';
  sab: SharedArrayBuffer;
  capacity: number;
  sampleRate: number;
  format: SampleFormat;
  /** Ring position of the take's first sample. Pre-roll is already applied. */
  startRead: number;
  /** Frames of that position which are pre-roll, for the manifest. */
  preRollFrames: number;
  /** Channels to write, in file order. The ring holds every input regardless. */
  tracks: { input: number; name: string }[];
  directory: FileSystemDirectoryHandle;
  folderName: string;
  startedAt: string;
  device: string;
}

export type ToWriter = StartMessage | { type: 'stop' };

export type FromWriter =
  | {
      type: 'health';
      fill: number;
      worstFill: number;
      dropped: number;
      worstWriteMs: number;
      bytes: number;
      frames: number;
    }
  | { type: 'started'; folderName: string }
  | { type: 'done'; manifest: TakeManifest; folderName: string }
  | { type: 'error'; message: string };

/**
 * Frames pulled from the ring per pass.
 *
 * One second is a deliberate compromise. Smaller passes give the disk more,
 * shorter writes than a filesystem would like; larger ones hold more of the
 * ring hostage while a write is in flight. The ring's headroom is what actually
 * absorbs a slow disk — this only sets how often it is asked.
 */
const CHUNK_SECONDS = 1;

/** How often the ring is checked. Well inside the headroom it is protecting. */
const PUMP_MS = 200;

/** How often the UI is told what the buffers are doing. */
const HEALTH_MS = 400;

interface TrackFile {
  input: number;
  name: string;
  file: string;
  writable: FileSystemWritableFileStream;
  header: ReturnType<typeof wavHeader>;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromWriter) => scope.postMessage(m);

let stopping = false;

scope.onmessage = (event: MessageEvent<ToWriter>) => {
  const msg = event.data;
  if (msg.type === 'start') void run(msg);
  else stopping = true;
};

async function run(cfg: StartMessage): Promise<void> {
  stopping = false;

  const ctrl = ringControl(cfg.sab);
  const chunk = cfg.sampleRate * CHUNK_SECONDS;
  const bytesPerFrame = frameBytes(cfg.format);
  const channels = cfg.tracks.map((t) => ringChannel(cfg.sab, t.input, cfg.capacity));

  // Allocated once and reused for the whole take. Past this point the writer
  // never asks the allocator for anything, so a take cannot be interrupted by
  // a collection this thread caused.
  const scratch = new Float32Array(chunk);
  const silence = new Float32Array(chunk);
  // One encode buffer per track, not one shared. `write()` queues the chunk it
  // is handed and is not required to have copied it by the time it returns, so
  // a shared buffer reused for the next track can be pulled out from under a
  // write that has not run yet. That corrupts a file only under load, which is
  // the worst possible time to find out, and never in a short test.
  // Typed as ArrayBuffer-backed rather than left to inference: the `write()`
  // overloads reject a view that might be over a SharedArrayBuffer, and these
  // are not — the shared one is read through `scratch`.
  const encoded: Uint8Array<ArrayBuffer>[] = cfg.tracks.map(
    () => new Uint8Array(chunk * bytesPerFrame),
  );

  let files: TrackFile[] = [];
  let read = cfg.startRead >>> 0;
  let frames = 0;
  let dropped = 0;
  let bytes = 0;
  let fill = 0;
  let worstFill = 0;
  let worstWriteMs = 0;
  const gaps: Gap[] = [];

  try {
    const folder = await cfg.directory.getDirectoryHandle(cfg.folderName, { create: true });
    for (const t of cfg.tracks) {
      const file = trackFileName(t.input, t.name);
      const handle = await folder.getFileHandle(file, { create: true });
      const writable = await handle.createWritable();
      const header = wavHeader(cfg.sampleRate, cfg.format);
      // The header goes down with zeroed sizes and is patched at close. A
      // streaming recorder has no other option: RIFF declares its length in its
      // first bytes, and the length is not known until someone presses stop.
      await writable.write(header.bytes);
      files.push({ input: t.input, name: t.name, file, writable, header });
    }
    post({ type: 'started', folderName: cfg.folderName });
  } catch (err) {
    // Close anything that did open, or the browser leaves swap files behind.
    await Promise.all(files.map((f) => f.writable.close().catch(() => {})));
    files = [];
    post({ type: 'error', message: `could not create the take: ${describe(err)}` });
    return;
  }

  /**
   * Write `count` frames to every track, from a per-track source.
   *
   * The tracks go out together rather than one after another so the OS gets to
   * schedule them, and `frames` only advances once they have all landed — which
   * is what makes it impossible for one slow file to fall behind the others.
   */
  async function writeAll(source: (track: number) => Float32Array, count: number): Promise<void> {
    const t0 = performance.now();
    const pending: Promise<void>[] = [];
    for (let i = 0; i < files.length; i++) {
      const n = encode(source(i), count, cfg.format, encoded[i]);
      pending.push(files[i].writable.write(encoded[i].subarray(0, n)));
      bytes += n;
    }
    await Promise.all(pending);
    const dt = performance.now() - t0;
    if (dt > worstWriteMs) worstWriteMs = dt;
    frames += count;
  }

  let lastHealth = 0;
  try {
    for (;;) {
      const span = ringAvailable(ctrl, cfg.capacity, read);

      if (span.lost > 0) {
        gaps.push({ atFrame: frames, frames: span.lost });
        dropped += span.lost;
        let left = span.lost;
        while (left > 0) {
          const n = Math.min(left, chunk);
          await writeAll(() => silence, n);
          left -= n;
        }
        read = (read + span.lost) >>> 0;
      }

      let available = span.frames;
      fill = available / cfg.capacity;
      if (fill > worstFill) worstFill = fill;

      // On a stop, take everything. Otherwise leave a part-chunk for the next
      // pass rather than making a tiny write out of it.
      while (available >= (stopping ? 1 : chunk)) {
        const n = Math.min(available, chunk);
        const at = read;
        await writeAll((i) => {
          ringRead(channels[i], cfg.capacity, at, n, scratch);
          return scratch;
        }, n);
        read = (read + n) >>> 0;
        available -= n;

        if ((frames + chunk) * bytesPerFrame + 128 > RIFF_LIMIT) {
          post({
            type: 'error',
            message:
              'stopped at the 4 GB WAV limit — a RIFF header cannot describe more than that, ' +
              'whatever wrote it. The take up to this point is intact.',
          });
          stopping = true;
          break;
        }
      }

      const now = performance.now();
      if (now - lastHealth > HEALTH_MS) {
        lastHealth = now;
        post({ type: 'health', fill, worstFill, dropped, worstWriteMs, bytes, frames });
      }

      if (stopping) break;
      await sleep(PUMP_MS);
    }

    for (const f of files) {
      for (const p of sizePatches(f.header, frames, cfg.format)) {
        await f.writable.write({ type: 'write', position: p.position, data: p.data });
      }
      // close() is what moves the staged data into the real file. Until it
      // returns, nothing outside the browser can see the take.
      await f.writable.close();
    }

    const manifest: TakeManifest = {
      quickdaw: 1,
      name: cfg.folderName,
      startedAt: cfg.startedAt,
      sampleRate: cfg.sampleRate,
      format: cfg.format,
      frames,
      preRollFrames: cfg.preRollFrames,
      device: cfg.device,
      tracks: files.map((f) => ({ input: f.input, name: f.name, file: f.file })),
      gaps,
    };

    const folder = await cfg.directory.getDirectoryHandle(cfg.folderName, { create: false });
    const meta = await folder.getFileHandle('take.json', { create: true });
    const metaOut = await meta.createWritable();
    await metaOut.write(JSON.stringify(manifest, null, 2));
    await metaOut.close();

    post({ type: 'health', fill, worstFill, dropped, worstWriteMs, bytes, frames });
    post({ type: 'done', manifest, folderName: cfg.folderName });
  } catch (err) {
    await Promise.all(files.map((f) => f.writable.close().catch(() => {})));
    post({ type: 'error', message: `writing stopped: ${describe(err)}` });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
