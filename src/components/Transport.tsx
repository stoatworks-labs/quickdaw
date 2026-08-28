/**
 * Record, stop, and everything that has to be true before either is offered.
 *
 * The elapsed time and the buffer health are written into the DOM from a
 * `requestAnimationFrame` loop rather than held in state: they change several
 * times a second for the length of a take, and a take is the one time the app
 * must not be re-rendering the whole page on a clock.
 */

import { useEffect, useRef } from 'react';
import { recorder } from '../lib/recorder';
import { formatBytes, formatTime } from '../lib/format';
import type { EngineStatus } from '../types';

interface Props {
  status: EngineStatus;
  armedCount: number;
  bytesPerSecond: number;
  preRoll: boolean;
  preRollSeconds: number;
  canRecord: boolean;
  blockedReason: string | null;
  onRecord: () => void;
  onStop: () => void;
}

export function Transport({
  status,
  armedCount,
  bytesPerSecond,
  preRoll,
  preRollSeconds,
  canRecord,
  blockedReason,
  onRecord,
  onStop,
}: Props) {
  const clock = useRef<HTMLSpanElement | null>(null);
  const fill = useRef<HTMLDivElement | null>(null);
  const stats = useRef<HTMLSpanElement | null>(null);
  const recording = status === 'recording';

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const rate = recorder.info.sampleRate || 48000;

      if (clock.current) {
        const text = formatTime(recorder.takeFrames, rate);
        if (clock.current.textContent !== text) clock.current.textContent = text;
      }
      if (fill.current) {
        // The bar is how much of the ring the writer has not yet consumed. At
        // rest it sits near zero; a disk that pauses pushes it up, and it
        // reaching the end is the moment frames start being lost. It is the
        // one number that says whether the recording is safe right now.
        fill.current.style.width = `${Math.min(100, recorder.health.fill * 100).toFixed(1)}%`;
      }
      if (stats.current) {
        const h = recorder.health;
        const text =
          `${formatBytes(h.bytes)} written · peak buffer ${(h.worstFill * 100).toFixed(0)}%` +
          ` · slowest write ${h.worstWriteMs.toFixed(0)} ms` +
          (h.dropped > 0 ? ` · ${h.dropped} frames lost` : '');
        if (stats.current.textContent !== text) stats.current.textContent = text;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <section className="transport" aria-label="Transport">
      <div className="transport-buttons">
        <button
          type="button"
          className={`record${recording ? ' active' : ''}`}
          onClick={recording ? onStop : onRecord}
          disabled={!canRecord && !recording}
          title={blockedReason ?? (recording ? 'Stop and close the files' : 'Start a take')}
        >
          {recording ? '■ Stop' : '● Record'}
        </button>
        <span className="clock" ref={clock}>
          0:00.000
        </span>
      </div>

      <div className="transport-meta">
        {blockedReason ? (
          <p className="blocked">{blockedReason}</p>
        ) : (
          <p>
            {armedCount} track{armedCount === 1 ? '' : 's'} armed ·{' '}
            {formatBytes(bytesPerSecond)}/s ·{' '}
            {preRoll ? (
              <strong>{preRollSeconds}s of pre-roll goes into the file</strong>
            ) : (
              'no pre-roll'
            )}
          </p>
        )}
        <div className="buffer" title="Ring buffer the writer has not yet consumed">
          <div className="buffer-fill" ref={fill} />
        </div>
        <span className="stats" ref={stats} />
      </div>
    </section>
  );
}
