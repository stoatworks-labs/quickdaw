/// <reference lib="webworker" />
/**
 * The playback reader: a take's files into the ring, ahead of the audio thread.
 *
 * The mirror of `writer.ts`, and off the main thread for the same reason — the
 * side with a deadline here is the worklet, and the ring is what stands between
 * it and however long a disk read decides to take.
 *
 * ## Nothing is decoded
 *
 * QuickDaw wrote these files, so their contents are known: raw little-endian
 * PCM behind a header this app produced. There is no codec to run, no
 * `decodeAudioData`, and no reason to hold a whole take in memory to play it —
 * a byte range is read, converted to floats, and pushed into the ring. A
 * forty-minute sixteen-track take plays out of a few megabytes of buffers.
 *
 * ## Seeking, and the generation counter
 *
 * A seek is not a jump. The consumer is stopped, the ring is emptied, the file
 * position moves, the ring is refilled, and only then does the consumer start
 * again. Doing it in any other order plays what was still in the ring from
 * before the jump — a fraction of a second of the wrong part of the take, which
 * sounds exactly like a fault in the recording.
 *
 * A fill already in flight when the seek arrives would write its bytes at the
 * old position and undo all of that. Rather than wait for it — which cannot be
 * done from an async function without starving the event loop the awaited read
 * needs — every seek increments `generation`, and a fill whose generation is
 * stale discards what it read and returns.
 */

import {
  CTRL_RUN,
  CTRL_WRITE,
  ringControl,
  ringChannel,
  ringFree,
  ringReadPosition,
  ringRewind,
  ringWrite,
  ringWritePosition,
} from '../lib/ring';
import { decode, frameBytes, readWavInfo, type SampleFormat } from '../lib/wav';

export interface LoadMessage {
  type: 'load';
  sab: SharedArrayBuffer;
  capacity: number;
  format: SampleFormat;
  frames: number;
  /** One per ring channel, in ring-channel order. */
  files: FileSystemFileHandle[];
}

export type ToReader =
  | LoadMessage
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; frame: number }
  | { type: 'close' };

export type FromReader =
  | { type: 'ready'; frames: number }
  | { type: 'base'; frame: number }
  | { type: 'ended' }
  | { type: 'error'; message: string };

/** Frames read per pass, per track. Enough that a disk sees a useful request. */
const CHUNK = 16384;

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromReader) => scope.postMessage(m);

interface Source {
  file: File;
  dataOffset: number;
  data: Float32Array;
}

let ctrl: Int32Array | null = null;
let capacity = 0;
let format: SampleFormat = 'float32';
let totalFrames = 0;
let sources: Source[] = [];
let scratch = new Float32Array(CHUNK);
/** Next frame to read out of the files. */
let position = 0;
let playing = false;
let pumping = false;
let closed = false;
/** Bumped by every seek. A fill from an older generation throws its work away. */
let generation = 0;

scope.onmessage = (event: MessageEvent<ToReader>) => void handle(event.data);

async function handle(msg: ToReader): Promise<void> {
  try {
    if (msg.type === 'load') return await load(msg);
    if (!ctrl) return;
    if (msg.type === 'play') {
      // Playing from the end starts again from the beginning, which is what a
      // transport does and saves a seek nobody would think to ask for.
      if (position >= totalFrames && drained()) await seek(0);
      playing = true;
      Atomics.store(ctrl, CTRL_RUN, 1);
      void pump();
    } else if (msg.type === 'pause') {
      playing = false;
      Atomics.store(ctrl, CTRL_RUN, 0);
    } else if (msg.type === 'seek') {
      await seek(msg.frame);
    } else if (msg.type === 'close') {
      closed = true;
      playing = false;
      Atomics.store(ctrl, CTRL_RUN, 0);
      sources = [];
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

async function load(msg: LoadMessage): Promise<void> {
  ctrl = ringControl(msg.sab);
  capacity = msg.capacity;
  format = msg.format;
  totalFrames = msg.frames;
  closed = false;
  playing = false;
  scratch = new Float32Array(CHUNK);
  Atomics.store(ctrl, CTRL_RUN, 0);

  sources = [];
  for (let i = 0; i < msg.files.length; i++) {
    const file = await msg.files[i].getFile();
    // 4 kB is past any header this app writes, and past the metadata chunks a
    // DAW may have added if the file has been through one since.
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    const info = readWavInfo(head);
    sources.push({ file, dataOffset: info.dataOffset, data: ringChannel(msg.sab, i, capacity) });
  }

  await seek(0);
  post({ type: 'ready', frames: totalFrames });
}

function drained(): boolean {
  return !!ctrl && ((ringWritePosition(ctrl) - ringReadPosition(ctrl)) >>> 0) === 0;
}

async function seek(frame: number): Promise<void> {
  if (!ctrl) return;
  const wasPlaying = playing;
  // Stop the consumer before touching the positions, and invalidate any fill
  // that is part-way through a read.
  Atomics.store(ctrl, CTRL_RUN, 0);
  playing = false;
  const gen = ++generation;

  position = Math.max(0, Math.min(frame, totalFrames));
  ringRewind(ctrl);
  post({ type: 'base', frame: position });

  await fill(gen);
  // A second seek arriving during that fill owns the transport now; this one
  // must not resume playback under it.
  if (wasPlaying && gen === generation) {
    playing = true;
    Atomics.store(ctrl, CTRL_RUN, 1);
    void pump();
  }
}

/** Top the ring up. Returns when it is full or the files have run out. */
async function fill(gen: number): Promise<void> {
  if (!ctrl || closed) return;
  const bytes = frameBytes(format);
  while (gen === generation) {
    if (ringFree(ctrl, capacity) < CHUNK) return;
    const want = Math.min(CHUNK, totalFrames - position);
    if (want <= 0) return;

    const from = position * bytes;
    const to = from + want * bytes;
    const reads = await Promise.all(
      sources.map((s) => s.file.slice(s.dataOffset + from, s.dataOffset + to).arrayBuffer()),
    );
    // The reads above were awaited; a seek may have landed while they were out.
    // Everything after this point writes into the ring, so it must not run.
    if (gen !== generation || closed) return;

    const at = ringWritePosition(ctrl);
    for (let i = 0; i < sources.length; i++) {
      const raw = new Uint8Array(reads[i]);
      const got = decode(raw, format, scratch);
      // A file shorter than the manifest claims — a take interrupted before it
      // was closed — plays as silence for the missing part rather than as
      // whatever the previous chunk left in the buffer.
      if (got < want) scratch.fill(0, got, want);
      ringWrite(sources[i].data, capacity, at, want, scratch);
    }
    position += want;
    // Publish last, as ever: the frames must be in the ring before the consumer
    // is told they are there.
    Atomics.store(ctrl, CTRL_WRITE, (at + want) >>> 0);
  }
}

async function pump(): Promise<void> {
  if (pumping || !ctrl) return;
  pumping = true;
  try {
    while (playing && !closed) {
      const gen = generation;
      await fill(gen);
      if (gen !== generation) continue; // a seek took over
      if (position >= totalFrames && drained()) {
        playing = false;
        Atomics.store(ctrl, CTRL_RUN, 0);
        post({ type: 'ended' });
        break;
      }
      await sleep(50);
    }
  } finally {
    pumping = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
