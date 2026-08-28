/**
 * Formatting shared by everything that puts a number on screen.
 *
 * Kept in one place because a recorder shows the same quantities in several
 * panels, and a timecode that counts differently in the transport than in the
 * take list is the kind of inconsistency that makes people distrust the whole
 * display.
 */

/** `1:23.456` — minutes, seconds, milliseconds. Hours appear only when needed. */
export function formatTime(frames: number, sampleRate: number): string {
  if (!sampleRate) return '0:00.000';
  const total = Math.max(0, frames) / sampleRate;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.floor((total % 1) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const head = h > 0 ? `${h}:${pad(m)}` : `${m}`;
  return `${head}:${pad(s)}.${pad(ms, 3)}`;
}

/** `-12.3` — one decimal, and a floor rather than a run of minus signs. */
export function formatDb(db: number, floor = -120): string {
  if (!Number.isFinite(db) || db <= floor) return '-∞';
  return db.toFixed(1);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Bytes one second of a take occupies, across every armed track.
 *
 * Shown before a take rather than discovered during one: at 96 kHz, 32 tracks
 * of 32-bit float is 44 MB a minute, and knowing that in advance is the
 * difference between choosing 24-bit deliberately and running out of disk.
 */
export function bytesPerSecond(channels: number, sampleRate: number, bytesPerFrame: number): number {
  return channels * sampleRate * bytesPerFrame;
}

/**
 * Position of a level on a meter, 0 at the bottom and 1 at the top.
 *
 * Not linear in dB. A meter with a linear scale spends most of its height on
 * levels nothing is ever at and squeezes the region that matters — the top 20
 * dB, where the decision to turn something down gets made — into a few pixels.
 * The curve below gives the top 24 dB half the meter and still shows a signal
 * 60 dB down as being present rather than as nothing at all.
 */
export function meterPosition(db: number, floor = -72): number {
  if (db <= floor) return 0;
  if (db >= 0) return 1;
  const x = 1 - db / floor; // 0 at the floor, 1 at full scale
  return Math.pow(x, 2.2);
}
