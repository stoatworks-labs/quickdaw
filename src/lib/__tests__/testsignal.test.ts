/**
 * The generated source's levels.
 *
 * The app makes a claim on screen about this signal — input 1 reads -18 dBFS —
 * and offers it as the way to check the meters before trusting the recorder
 * with a session. A reference that is not exact is worse than no reference,
 * because it turns a working meter into a suspect one.
 */

import { describe, expect, it } from 'vitest';
import {
  REFERENCE_DB,
  REFERENCE_HZ,
  TEST_CHANNELS,
  testChannelPlan,
} from '../testsignal';
import { meterPosition } from '../format';

const plan = testChannelPlan();

describe('testChannelPlan', () => {
  it('has one entry per generated channel', () => {
    expect(plan).toHaveLength(TEST_CHANNELS);
  });

  it('makes channel 1 an exact, steady alignment reference', () => {
    // 1 kHz at -18 dBFS is a real alignment tone at a real alignment level, so
    // "input 1 should read -18" is a check anyone can make against a number.
    expect(plan[0].hz).toBe(REFERENCE_HZ);
    expect(plan[0].db).toBe(REFERENCE_DB);
    expect(REFERENCE_DB).toBe(-18);
    // Not modulated. A wandering reference is not a reference.
    expect(plan[0].tremoloHz).toBe(0);
  });

  it('descends in level after the reference', () => {
    const rest = plan.slice(1);
    for (let i = 1; i < rest.length; i++) {
      expect(rest[i].db).toBeLessThan(rest[i - 1].db);
    }
  });

  it('keeps every channel below full scale and above the meter floor', () => {
    // Nothing may clip: a source offered as a check must not light the clip
    // indicator by itself, or the indicator means nothing. And nothing may sit
    // under the meter's floor, or a channel reads as dead.
    for (const ch of plan) {
      expect(ch.db).toBeLessThan(0);
      expect(meterPosition(ch.db)).toBeGreaterThan(0);
      expect(meterPosition(ch.db)).toBeLessThan(1);
    }
  });

  it('survives the tremolo without clipping', () => {
    // The tremolo adds up to 40% of each channel's own linear gain. The loudest
    // modulated channel at the top of its swing still has to stay under full
    // scale, or the check quietly becomes a clip test.
    for (const ch of plan) {
      const peak = Math.pow(10, ch.db / 20) * (ch.tremoloHz > 0 ? 1.4 : 1);
      expect(peak).toBeLessThan(1);
    }
  });

  it('gives every channel its own tone and its own tremolo rate', () => {
    // Eight bars moving together look like one source shown eight times, which
    // is the opposite of what this is demonstrating.
    expect(new Set(plan.map((c) => c.hz)).size).toBe(TEST_CHANNELS);
    const rates = plan.slice(1).map((c) => c.tremoloHz);
    expect(new Set(rates).size).toBe(rates.length);
    // Slow enough to read as breathing rather than as a warble.
    for (const r of rates) expect(r).toBeLessThan(1);
  });

  it('stays in the audible band', () => {
    for (const ch of plan) {
      expect(ch.hz).toBeGreaterThan(20);
      expect(ch.hz).toBeLessThan(20000);
    }
  });
});
