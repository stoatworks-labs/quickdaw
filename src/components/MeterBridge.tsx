/**
 * The meter bridge: every input at once, above the record button.
 *
 * This is the answer to "is anything actually arriving?", and it is deliberately
 * the largest thing on the page after the transport. The per-track meters in the
 * track rows are for setting a level on one input; this is for seeing, at a
 * glance and from across a room, that the interface is feeding the page at all.
 *
 * It runs from the moment a device is open — arming and recording have nothing
 * to do with it. That matters, because the question it answers is one people ask
 * *before* they press record, and a meter that only moves during a take is no
 * use for the check it is most needed for.
 *
 * ## One canvas, not one per channel
 *
 * Thirty-two channels means thirty-two of everything if each bar is its own
 * element. Drawing the whole bridge into a single canvas in a single
 * `requestAnimationFrame` pass keeps it to one context, one clear and one loop,
 * and no level ever passes through React state.
 *
 * ## The scale is the same function the bars use
 *
 * Both the grid lines and the bar heights come from `meterPosition`, so a bar
 * reaching the -18 line means the level is -18. Drawing the grid at even
 * spacing while the bars use a curve would produce a meter that looks precise
 * and lies, which is worse than one with no scale at all.
 */

import { useEffect, useRef } from 'react';
import { recorder, SILENCE_DB } from '../lib/recorder';
import { meterPosition } from '../lib/format';
import { levelColour, meterColours, SCALE_MARKS, SIGNAL_FLOOR_DB } from '../lib/theme';
import type { Level, Track } from '../types';

interface Props {
  tracks: Track[];
  channels: number;
  /** Set while a device is opening, so the bridge can say so rather than sit blank. */
  opening: boolean;
}

/** Width of the dB scale gutter down the left, in CSS pixels. */
const GUTTER = 30;
/** Room under the bars for the channel numbers. */
const FOOT = 15;
/** Room above the bars for the clip flags. */
const HEAD = 9;
/** Widest a single channel's slot is allowed to get. See the note in `draw`. */
const MAX_SLOT = 34;

export function MeterBridge({ tracks, channels, opening }: Props) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (channels === 0) return;
    let raf = 0;
    const level: Level = { peakDb: SILENCE_DB, rmsDb: SILENCE_DB, holdDb: SILENCE_DB, clipped: false };
    const el = canvas.current;
    if (!el) return;
    const c = meterColours(document.documentElement);

    // The accessible summary is rebuilt twice a second, not per frame. A canvas
    // is invisible to a screen reader, and an aria-label that changed sixty
    // times a second would be worse than none — assistive technology would read
    // it continuously and never finish a sentence.
    let lastSummary = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const ctx = el.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const cssW = el.clientWidth;
      const cssH = el.clientHeight;
      if (!cssW || !cssH) return;
      const w = Math.round(cssW * dpr);
      const h = Math.round(cssH * dpr);
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
      }
      // Draw in CSS pixels and let the transform handle the device ratio, so
      // every size below is a number someone can reason about.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const top = HEAD;
      const bottom = cssH - FOOT;
      const height = bottom - top;
      const left = GUTTER;
      const span = cssW - left;
      if (height <= 0 || span <= 0) return;

      // Bars share the width evenly with a gap between them. Below about six
      // pixels a bar stops reading as a level and starts reading as a line, so
      // the gap is what gives way first.
      //
      // The cap matters at low channel counts: a stereo interface across a
      // 1000-pixel panel would otherwise draw two 500-pixel slabs, which reads
      // as a bar chart of two things rather than as a meter. Capped, two
      // channels look like the left of a meter bridge with room to grow, which
      // is what it is.
      const slot = Math.min(span / channels, MAX_SLOT);
      const gap = slot > 14 ? 3 : slot > 8 ? 2 : 1;
      const barW = Math.max(1, slot - gap);

      const y = (db: number) => bottom - meterPosition(db) * height;

      // The grid is ruled across the bars only, not the whole panel. Once the
      // slot width is capped, a small interface leaves most of the width empty,
      // and lines running out across it read as a broken layout rather than as
      // a scale.
      const ruled = slot * channels;

      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      for (const mark of SCALE_MARKS) {
        const my = y(mark);
        ctx.fillStyle = c.grid;
        ctx.fillRect(left, my, ruled, 1);
        ctx.fillStyle = c.label;
        ctx.fillText(String(mark), GUTTER - 5, my);
      }

      let present = 0;
      let clipping = 0;
      ctx.textAlign = 'center';

      for (let i = 0; i < channels; i++) {
        recorder.level(i, level);
        const x = left + i * slot + gap / 2;
        const armed = tracks[i]?.armed ?? true;
        // A disarmed input is still metered — it is still arriving, it just is
        // not being written — so it is dimmed rather than hidden.
        ctx.globalAlpha = armed ? 1 : 0.4;

        ctx.fillStyle = c.back;
        ctx.fillRect(x, top, barW, height);

        if (level.peakDb > SILENCE_DB) {
          const py = y(level.peakDb);
          ctx.fillStyle = levelColour(level.peakDb, c);
          ctx.fillRect(x, py, barW, bottom - py);
        }

        // RMS drawn over the peak, inset, in a cooler colour. Peak says whether
        // it is about to clip; RMS says how loud it is. They are not the same
        // number and a meter showing only one of them is only half a meter.
        if (level.rmsDb > SILENCE_DB && barW >= 4) {
          const ry = y(level.rmsDb);
          ctx.fillStyle = c.rms;
          ctx.fillRect(x + barW * 0.3, ry, barW * 0.4, bottom - ry);
        }

        if (level.holdDb > SILENCE_DB) {
          const hy = y(level.holdDb);
          ctx.fillStyle = c.hold;
          ctx.fillRect(x, Math.max(top, hy - 1), barW, 1.5);
        }

        // The clip flag latches. Only a person clearing it, or a new take,
        // puts it out — a clip you can miss by looking away is not a warning.
        if (level.clipped) {
          clipping++;
          ctx.fillStyle = c.high;
          ctx.fillRect(x, 0, barW, HEAD - 3);
        }
        if (level.peakDb > SIGNAL_FLOOR_DB) present++;

        if (slot >= 13) {
          ctx.fillStyle = c.label;
          ctx.fillText(String(i + 1), x + barW / 2, cssH - FOOT / 2);
        }
        ctx.globalAlpha = 1;
      }

      if (now - lastSummary > 500) {
        lastSummary = now;
        const label =
          `${present} of ${channels} input${channels === 1 ? '' : 's'} receiving signal` +
          (clipping > 0 ? `, ${clipping} clipping` : '');
        if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
        const live = wrap.current?.querySelector('.bridge-summary');
        if (live && live.textContent !== label) live.textContent = label;
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // `tracks` is read inside the loop for the armed state. Re-running the
    // effect on every keystroke in a track name would restart the animation
    // loop; the loop reads the latest array through the closure instead, which
    // is refreshed by this dependency without the loop ever being torn down
    // mid-frame.
  }, [channels, tracks]);

  if (channels === 0) {
    return (
      <section className="bridge empty-bridge" aria-label="Input meters">
        <p className="empty">
          {opening
            ? 'Opening the device…'
            : 'Choose an interface and every input is metered here, live, before you record anything.'}
        </p>
      </section>
    );
  }

  return (
    <section className="bridge" aria-label="Input meters" ref={wrap}>
      <div className="bridge-head">
        <h2>Inputs</h2>
        <span className="hint">
          Live from the interface — running before you record, and whether or not a track is armed.
        </span>
        <button type="button" className="link" onClick={() => recorder.clearClips()}>
          clear clip
        </button>
      </div>
      <canvas
        className="bridge-canvas"
        ref={canvas}
        role="img"
        aria-label="Input meters"
        onClick={() => recorder.clearClips()}
        title="Click to clear the clip indicators"
      />
      {/* The numbers a canvas cannot give a screen reader. Polite, and rebuilt
          twice a second rather than per frame. */}
      <p className="bridge-summary visually-hidden" aria-live="polite" />
    </section>
  );
}
