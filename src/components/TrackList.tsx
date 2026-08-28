/**
 * The track strip: one row per input on the interface, mapped 1:1.
 *
 * ## Every meter is drawn by one loop
 *
 * There is a canvas per row, but a single `requestAnimationFrame` loop for all
 * of them, and it reads the engine's shared meter buffer directly. No level
 * passes through React state. Thirty-two channels at the display rate is around
 * two thousand state updates a second, and React would spend a core deciding
 * that a `<div>` had not changed.
 *
 * The loop also stops itself when the document is hidden, which the browser
 * would do anyway — the note is here because it is the reason a meter can look
 * frozen for a moment when a tab comes back, while the audio never was.
 */

import { useEffect, useRef } from 'react';
import { recorder, SILENCE_DB } from '../lib/recorder';
import { formatDb, meterPosition } from '../lib/format';
import type { Level, Track } from '../types';

interface Props {
  tracks: Track[];
  recording: boolean;
  onChange: (input: number, patch: Partial<Track>) => void;
  onClearSolo: () => void;
}

/**
 * Colours read from the stylesheet so the meter cannot drift from the theme.
 *
 * Read once, on mount, and not per frame. `getComputedStyle` forces a style
 * recalculation, and calling it for every channel on every animation frame is
 * around two thousand forced recalculations a second — enough on its own to
 * make the meters stutter, on a page whose entire point is that nothing
 * stutters.
 */
function meterColours(el: Element) {
  const s = getComputedStyle(el);
  return {
    back: s.getPropertyValue('--meter-back').trim() || '#15181d',
    low: s.getPropertyValue('--meter-low').trim() || '#3ba55d',
    mid: s.getPropertyValue('--meter-mid').trim() || '#d8b13a',
    high: s.getPropertyValue('--meter-high').trim() || '#d1453b',
    hold: s.getPropertyValue('--meter-hold').trim() || '#e6ebf2',
    rms: s.getPropertyValue('--meter-rms').trim() || '#8ea6c8',
  };
}

export function TrackList({ tracks, recording, onChange, onClearSolo }: Props) {
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const readouts = useRef<(HTMLSpanElement | null)[]>([]);
  const anySolo = tracks.some((t) => t.soloed);

  useEffect(() => {
    let raf = 0;
    const level: Level = { peakDb: SILENCE_DB, rmsDb: SILENCE_DB, holdDb: SILENCE_DB, clipped: false };
    const c = meterColours(document.documentElement);
    let clipGeneration = recorder.clipGeneration;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cleared = recorder.clipGeneration !== clipGeneration;
      if (cleared) clipGeneration = recorder.clipGeneration;

      for (let i = 0; i < canvases.current.length; i++) {
        const canvas = canvases.current[i];
        if (!canvas) continue;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;

        // Size to the device pixel ratio here rather than in a resize handler:
        // the row height is fixed, the check is two comparisons, and it picks
        // up a window dragged to a second screen with a different ratio.
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }

        recorder.level(i, level);
        ctx.fillStyle = c.back;
        ctx.fillRect(0, 0, w, h);

        // Peak bar, coloured by where its top is rather than as a gradient: the
        // point of the colour is to say which band the level is in, and a
        // gradient says that only at the very tip while implying it about the
        // whole bar.
        const peak = meterPosition(level.peakDb) * w;
        ctx.fillStyle = level.peakDb > -3 ? c.high : level.peakDb > -18 ? c.mid : c.low;
        ctx.fillRect(0, 0, peak, h);

        // RMS as a second, shorter bar inside the first. Peak says whether it
        // will clip; RMS says how loud it is. Both matter and they are not the
        // same number.
        const rms = meterPosition(level.rmsDb) * w;
        ctx.fillStyle = c.rms;
        ctx.fillRect(0, h * 0.35, rms, h * 0.3);

        if (level.holdDb > SILENCE_DB) {
          const hold = meterPosition(level.holdDb) * w;
          ctx.fillStyle = c.hold;
          ctx.fillRect(Math.max(0, hold - dpr), 0, dpr * 1.5, h);
        }

        // The numeric readout is written straight into the DOM node, for the
        // same reason the bar is drawn on a canvas: it changes sixty times a
        // second on every channel, and it is not something React should hear
        // about. The clip flag latches until it is cleared, so it is set here
        // and never unset by this loop.
        const out = readouts.current[i];
        if (out) {
          const text = formatDb(level.peakDb);
          if (out.textContent !== text) out.textContent = text;
          if (cleared) out.classList.remove('clip');
          if (level.clipped) out.classList.add('clip');
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (tracks.length === 0) {
    return <p className="empty">Choose an interface and its inputs appear here, one track each.</p>;
  }

  return (
    <div className="tracks">
      <div className="tracks-head">
        <span className="col-num">In</span>
        <span className="col-name">Track</span>
        <span className="col-arm">Rec</span>
        <span className="col-meter">Level</span>
        <span className="col-mix">Playback</span>
        {anySolo && (
          <button type="button" className="link" onClick={onClearSolo}>
            clear solo
          </button>
        )}
      </div>

      {tracks.map((t, i) => {
        return (
          <div className={`track${t.armed ? '' : ' disarmed'}`} key={t.input}>
            <span className="col-num">{t.input + 1}</span>

            <input
              className="col-name"
              value={t.name}
              aria-label={`Name of input ${t.input + 1}`}
              onChange={(e) => onChange(t.input, { name: e.target.value })}
            />

            <button
              type="button"
              className={`arm${t.armed ? ' on' : ''}`}
              aria-pressed={t.armed}
              // Arming during a take would have to open a file mid-recording and
              // the track would start late against every other one. The take is
              // fixed at the moment record is pressed.
              disabled={recording}
              title={recording ? 'The armed set is fixed for the length of a take' : 'Record this input'}
              onClick={() => onChange(t.input, { armed: !t.armed })}
            >
              ●
            </button>

            <div className="col-meter">
              <canvas
                ref={(el) => {
                  canvases.current[i] = el;
                }}
                className="meter"
              />
              <span
                className="readout"
                ref={(el) => {
                  readouts.current[i] = el;
                }}
              >
                -&#8734;
              </span>
            </div>

            <div className="col-mix">
              <input
                type="range"
                min={-40}
                max={12}
                step={0.5}
                value={t.gainDb}
                aria-label={`Playback gain, input ${t.input + 1}`}
                onChange={(e) => onChange(t.input, { gainDb: Number(e.target.value) })}
              />
              <input
                type="range"
                min={-1}
                max={1}
                step={0.02}
                value={t.pan}
                aria-label={`Playback pan, input ${t.input + 1}`}
                onChange={(e) => onChange(t.input, { pan: Number(e.target.value) })}
              />
              <button
                type="button"
                className={`tiny${t.muted ? ' on' : ''}`}
                aria-pressed={t.muted}
                onClick={() => onChange(t.input, { muted: !t.muted })}
              >
                M
              </button>
              <button
                type="button"
                className={`tiny solo${t.soloed ? ' on' : ''}`}
                aria-pressed={t.soloed}
                onClick={() => onChange(t.input, { soloed: !t.soloed })}
              >
                S
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
