/**
 * The takes, and the transport that plays one back.
 *
 * The playhead and the output meter come off the player on the display clock,
 * for the same reason as everywhere else here: they move continuously, and
 * React should not be told about a number that changes sixty times a second.
 * The scrubber is the exception — it is an input, so its value is state, and it
 * is written by the same loop rather than re-rendered.
 */

import { useEffect, useRef } from 'react';
import { player } from '../lib/player';
import { formatTime, meterPosition } from '../lib/format';
import { toDb } from '../lib/recorder';
import type { TakeManifest } from '../types';

interface Props {
  takes: TakeManifest[];
  loaded: TakeManifest | null;
  playing: boolean;
  masterGainDb: number;
  onLoad: (take: TakeManifest) => void;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (frame: number) => void;
  onMasterGain: (db: number) => void;
}

export function TakePanel({
  takes,
  loaded,
  playing,
  masterGainDb,
  onLoad,
  onPlay,
  onPause,
  onSeek,
  onMasterGain,
}: Props) {
  const scrub = useRef<HTMLInputElement | null>(null);
  const clock = useRef<HTMLSpanElement | null>(null);
  const meter = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const frames = player.frames;
      if (!frames) return;
      const at = player.position();

      // Do not fight the user's hand. While the scrubber is being dragged its
      // value is theirs, and writing the playhead into it would drag it back.
      if (scrub.current && !dragging.current) scrub.current.value = String(at);
      if (clock.current) {
        const text = `${formatTime(at, player.sampleRate)} / ${formatTime(frames, player.sampleRate)}`;
        if (clock.current.textContent !== text) clock.current.textContent = text;
      }
      if (meter.current) {
        meter.current.style.width = `${(meterPosition(toDb(player.outputPeak())) * 100).toFixed(1)}%`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <section className="takes" aria-label="Takes">
      <h2>Takes</h2>
      {takes.length === 0 ? (
        <p className="empty">Nothing recorded yet in this session.</p>
      ) : (
        <ul className="take-list">
          {takes.map((t) => (
            <li key={t.name} className={loaded?.name === t.name ? 'current' : undefined}>
              <button type="button" className="take" onClick={() => onLoad(t)}>
                <span className="take-name">{t.name}</span>
                <span className="take-meta">
                  {t.tracks.length} track{t.tracks.length === 1 ? '' : 's'} ·{' '}
                  {formatTime(t.frames, t.sampleRate)} · {t.sampleRate.toLocaleString()} Hz ·{' '}
                  {t.format === 'float32' ? '32-bit float' : '24-bit'}
                  {t.preRollFrames > 0 &&
                    ` · ${(t.preRollFrames / t.sampleRate).toFixed(1)}s pre-roll`}
                </span>
                {t.gaps.length > 0 && (
                  // A gap is a fact about the file, so it is stated on the take
                  // rather than being an alert that scrolls away. The audio is
                  // still aligned; there is silence where the frames were.
                  <span className="take-gaps">
                    {t.gaps.length} gap{t.gaps.length === 1 ? '' : 's'} —{' '}
                    {t.gaps.reduce((a, g) => a + g.frames, 0)} frames of silence stand in for audio
                    the disk could not take
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {loaded && (
        <div className="player">
          <div className="row">
            <button type="button" onClick={playing ? onPause : onPlay}>
              {playing ? '❙❙ Pause' : '▶ Play'}
            </button>
            <button type="button" onClick={() => onSeek(0)}>
              ⏮ Start
            </button>
            <span className="clock small" ref={clock}>
              0:00.000
            </span>
          </div>

          <input
            className="scrub"
            type="range"
            min={0}
            max={Math.max(1, loaded.frames)}
            step={1}
            defaultValue={0}
            ref={scrub}
            aria-label="Playback position"
            onPointerDown={() => (dragging.current = true)}
            onPointerUp={() => (dragging.current = false)}
            onKeyDown={() => (dragging.current = true)}
            onKeyUp={() => (dragging.current = false)}
            onChange={(e) => onSeek(Number(e.target.value))}
          />

          <div className="row">
            <span className="label">Output</span>
            <div className="buffer">
              <div className="buffer-fill" ref={meter} />
            </div>
            <input
              type="range"
              min={-40}
              max={12}
              step={0.5}
              value={masterGainDb}
              aria-label="Master gain"
              onChange={(e) => onMasterGain(Number(e.target.value))}
            />
          </div>
        </div>
      )}
    </section>
  );
}
