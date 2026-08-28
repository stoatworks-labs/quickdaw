/**
 * The meter's colour and scale rules.
 *
 * Small, but these decide what a person believes about their levels from across
 * a room, and both the bridge and the track rows read them — so the thing worth
 * pinning is that there is exactly one answer, not two that nearly agree.
 */

import { describe, expect, it } from 'vitest';
import { levelColour, SCALE_MARKS, SIGNAL_FLOOR_DB, type MeterColours } from '../theme';
import { meterPosition } from '../format';

const C: MeterColours = {
  back: 'back',
  low: 'low',
  mid: 'mid',
  high: 'high',
  hold: 'hold',
  rms: 'rms',
  grid: 'grid',
  label: 'label',
};

describe('levelColour', () => {
  it('bands at the levels a person actually decides on', () => {
    expect(levelColour(0, C)).toBe('high');
    expect(levelColour(-1, C)).toBe('high');
    expect(levelColour(-3, C)).toBe('mid'); // boundary is exclusive above
    expect(levelColour(-12, C)).toBe('mid');
    expect(levelColour(-18, C)).toBe('low');
    expect(levelColour(-60, C)).toBe('low');
  });

  it('never returns a colour the palette does not have', () => {
    const allowed = new Set([C.low, C.mid, C.high]);
    for (let db = -120; db <= 6; db += 0.5) {
      expect(allowed.has(levelColour(db, C))).toBe(true);
    }
  });
});

describe('SCALE_MARKS', () => {
  it('runs from the top down, with no repeats', () => {
    const marks = [...SCALE_MARKS];
    expect(marks[0]).toBe(0);
    expect(new Set(marks).size).toBe(marks.length);
    for (let i = 1; i < marks.length; i++) expect(marks[i]).toBeLessThan(marks[i - 1]);
  });

  it('sits inside the meter, so no line is drawn off the end of it', () => {
    for (const mark of SCALE_MARKS) {
      const p = meterPosition(mark);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it('is spaced by the same curve the bars use', () => {
    // The point of the test: a grid drawn at even spacing while the bars use a
    // curve produces a meter that looks precise and lies. Reading a mark's
    // position through `meterPosition` is what keeps them the same picture, so
    // the gaps between marks must be uneven — evenly spaced output would mean
    // something had quietly linearised.
    // Called through an arrow, not passed as `map(meterPosition)`: `map`
    // supplies the index as a second argument, which `meterPosition` takes as
    // its dB floor — so mark 0 would be measured against a floor of 0 and every
    // position would come out the same. It reads as a passing test of a broken
    // scale.
    const ys = SCALE_MARKS.map((db) => meterPosition(db));
    const gaps = ys.slice(1).map((v, i) => ys[i] - v);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(0.02);
  });
});

describe('SIGNAL_FLOOR_DB', () => {
  it('sits above a converter idling and below any real signal', () => {
    // Put it at the noise floor and every open input claims to have signal,
    // which is exactly the reassurance nobody needs from a meter.
    expect(SIGNAL_FLOOR_DB).toBeGreaterThan(-80);
    expect(SIGNAL_FLOOR_DB).toBeLessThan(-40);
    expect(meterPosition(SIGNAL_FLOOR_DB)).toBeGreaterThan(0);
  });
});
