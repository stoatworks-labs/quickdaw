import type { SampleFormat } from './lib/wav';

export type { SampleFormat };

/**
 * Pre-roll lengths offered, in seconds.
 *
 * The cost is linear and it is not small: every second held is
 * `sampleRate * channels * 4` bytes of resident memory, so 60 seconds of a
 * 32-channel interface at 96 kHz is 737 MB. The UI shows the figure for the
 * current interface rather than making anyone work it out, and 30 s is the
 * default because that is what the take you did not press record for is
 * usually inside.
 */
export const PREROLL_SECONDS = [10, 15, 30, 60, 120] as const;
export type PreRollSeconds = (typeof PREROLL_SECONDS)[number];

/**
 * Frames of ring held *beyond* the pre-roll, as a safety margin for the writer.
 *
 * The pre-roll and the write buffer are the same ring — pressing record simply
 * moves the writer's read position back in time rather than copying anything —
 * so this is the only part of it the writer gets to fall behind in. Eight
 * seconds is far more than a disk stall should ever need, and being generous
 * here costs one figure in a memory readout rather than any risk.
 */
export const WRITE_HEADROOM_SECONDS = 8;

export interface DeviceInfo {
  deviceId: string;
  label: string;
  /** Channels the device reported. 0 until it has been probed. */
  channels: number;
  /** Sample rate the device reported, in Hz. 0 until probed. */
  sampleRate: number;
}

export interface Track {
  /** Zero-based input index on the interface. Identity, and never changes. */
  input: number;
  name: string;
  armed: boolean;
  /** Playback-side controls. Recording is unaffected by these. */
  gainDb: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
}

/** Peak and RMS for one channel, in dBFS, plus a latching clip flag. */
export interface Level {
  peakDb: number;
  rmsDb: number;
  holdDb: number;
  clipped: boolean;
}

export type EngineStatus =
  | 'idle'
  | 'opening'
  | 'monitoring'
  | 'recording'
  | 'stopping'
  | 'error';

/** Where a take's files are being written. */
export type StorageKind = 'directory' | 'opfs';

export interface BufferHealth {
  /** Fraction of the ring holding frames the writer has not yet consumed. */
  fill: number;
  /** Worst `fill` seen since the take started. */
  worstFill: number;
  /** Frames the writer lost to the producer lapping it, this take. */
  dropped: number;
  /** Milliseconds the slowest single disk write took, this take. */
  worstWriteMs: number;
  /** Bytes written to disk, this take. */
  bytes: number;
}

export const EMPTY_HEALTH: BufferHealth = {
  fill: 0,
  worstFill: 0,
  dropped: 0,
  worstWriteMs: 0,
  bytes: 0,
};

/**
 * A gap in a take, in frames from the take's start.
 *
 * The writer pads the hole with silence so every track keeps its length and its
 * alignment, and records where it did so. A take with an empty `gaps` array is
 * a take that is known to be continuous — which is a claim worth being able to
 * make, and worth not making when it is not true.
 */
export interface Gap {
  atFrame: number;
  frames: number;
}

/** `take.json`, written beside the audio. The record of what the files are. */
export interface TakeManifest {
  quickdaw: 1;
  name: string;
  /** ISO instant of the *first sample*, pre-roll included — not of the button. */
  startedAt: string;
  sampleRate: number;
  format: SampleFormat;
  frames: number;
  /** Frames of pre-roll at the head of every file. 0 if pre-roll was off. */
  preRollFrames: number;
  device: string;
  tracks: { input: number; name: string; file: string }[];
  gaps: Gap[];
}

export interface Settings {
  deviceId: string | null;
  preRoll: boolean;
  preRollSeconds: PreRollSeconds;
  format: SampleFormat;
  /** Monitor the inputs through the default output. Off: a mic would feed back. */
  monitor: boolean;
  monitorGainDb: number;
  /** Keep the machine awake for the length of a take. */
  keepAwake: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  deviceId: null,
  preRoll: false,
  preRollSeconds: 30,
  format: 'float32',
  monitor: false,
  monitorGainDb: -12,
  keepAwake: true,
};

export function defaultTrack(input: number): Track {
  return {
    input,
    name: `Input ${input + 1}`,
    armed: true,
    gainDb: 0,
    pan: 0,
    muted: false,
    soloed: false,
  };
}
