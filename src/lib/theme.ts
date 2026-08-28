/**
 * Meter colours and the level-to-colour rule, read from the stylesheet.
 *
 * Shared by everything that draws a level, so the meter bridge and the track
 * rows cannot drift apart — they are the same signal shown twice, and two
 * greens that are almost the same reads as a fault in one of them.
 *
 * Read **once**, on mount, never per frame. `getComputedStyle` forces a style
 * recalculation; doing it per channel per animation frame is around two
 * thousand forced recalculations a second, which is enough on its own to make
 * the meters stutter on a page whose entire point is that nothing stutters.
 */
export interface MeterColours {
  back: string;
  low: string;
  mid: string;
  high: string;
  hold: string;
  rms: string;
  grid: string;
  label: string;
}

export function meterColours(el: Element): MeterColours {
  const s = getComputedStyle(el);
  const read = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    back: read('--meter-back', '#15181d'),
    low: read('--meter-low', '#3ba55d'),
    mid: read('--meter-mid', '#d8b13a'),
    high: read('--meter-high', '#d1453b'),
    hold: read('--meter-hold', '#e6ebf2'),
    rms: read('--meter-rms', '#8ea6c8'),
    grid: read('--line', '#262c36'),
    label: read('--dim', '#8b97a8'),
  };
}

/**
 * The colour a level is drawn in.
 *
 * Banded rather than a gradient: the colour exists to say which region the
 * level is in, and a gradient says that only at the very tip of the bar while
 * implying it about the whole thing. The boundaries are the ones a person
 * actually decides on — below -18 dBFS there is plenty of headroom, above -3
 * there is almost none.
 */
export function levelColour(db: number, c: MeterColours): string {
  return db > -3 ? c.high : db > -18 ? c.mid : c.low;
}

/**
 * Marks on the dB scale.
 *
 * Not evenly spaced, because the meter's own scale is not: they are the
 * numbers worth reading against. The top of the range gets most of them
 * because that is where the decision to turn something down gets made.
 */
export const SCALE_MARKS = [0, -6, -12, -18, -24, -36, -48, -60] as const;

/**
 * A level below this counts as nothing arriving.
 *
 * Well under any real signal and well over a converter's idle noise, which on a
 * quiet interface input sits somewhere near -90 dBFS. Sitting it at the noise
 * floor instead would make every open input claim to have signal, which is
 * exactly the reassurance nobody needs.
 */
export const SIGNAL_FLOOR_DB = -60;
