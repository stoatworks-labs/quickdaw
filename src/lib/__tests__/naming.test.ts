/**
 * File naming, the display helpers, and the pan law.
 *
 * A take recorded on a Mac gets opened on a PC, so the naming rules are the
 * strictest of the platforms rather than the host's. These are cheap tests for
 * a class of failure that only appears on someone else's machine.
 */

import { describe, expect, it } from 'vitest';
import { safeName, takeFolderName, trackFileName } from '../storage';
import { formatBytes, formatDb, formatTime, meterPosition } from '../format';
import { defaultTrack, type Track } from '../../types';
import { mixCoefficients, panGains } from '../mix';

describe('safeName', () => {
  it('removes what Windows will not accept', () => {
    expect(safeName('Kick: In/Out', 'x')).toBe('Kick- In-Out');
    expect(safeName('a<b>c"d|e?f*g\\h', 'x')).toBe('a-b-c-d-e-f-g-h');
  });

  it('keeps spaces, which are legal everywhere', () => {
    expect(safeName('Room L', 'x')).toBe('Room L');
    expect(safeName('Lead Vox 2', 'x')).toBe('Lead Vox 2');
  });

  it('removes control characters, which are not', () => {
    // These are illegal in a filename on every platform and invisible in every
    // editor, so a name carrying one fails at the moment the file is created
    // with nothing on screen to explain it.
    expect(safeName('Kick\u0000Snare', 'x')).toBe('Kick-Snare');
    expect(safeName('Tab\tHere', 'x')).toBe('Tab-Here');
  });

  it('strips a trailing dot or space, which Windows silently drops', () => {
    expect(safeName('Vocals.', 'x')).toBe('Vocals');
    expect(safeName('Vocals ', 'x')).toBe('Vocals');
  });

  it('escapes the reserved device names', () => {
    // `CON.wav` is not a creatable file on Windows however it is spelled.
    for (const n of ['CON', 'con', 'PRN', 'aux', 'NUL', 'COM1', 'LPT9']) {
      expect(safeName(n, 'x')).toBe(`_${n}`);
    }
    expect(safeName('CONTROL', 'x')).toBe('CONTROL');
  });

  it('falls back rather than producing an empty name', () => {
    expect(safeName('', 'Input 3')).toBe('Input 3');
    expect(safeName('   ', 'Input 3')).toBe('Input 3');
    expect(safeName('...', 'Input 3')).toBe('Input 3');
  });
});

describe('file and folder names', () => {
  it('numbers tracks so a DAW imports them in interface order', () => {
    expect(trackFileName(0, 'Kick')).toBe('01 Kick.wav');
    expect(trackFileName(9, 'Room L')).toBe('10 Room L.wav');
    expect(trackFileName(31, '')).toBe('32 Input 32.wav');
  });

  it('names folders so they sort chronologically', () => {
    const a = takeFolderName(new Date(2026, 7, 28, 9, 5, 3));
    const b = takeFolderName(new Date(2026, 7, 28, 14, 32, 5));
    expect(a).toBe('QuickDaw 2026-08-28 09-05-03');
    expect([b, a].sort()).toEqual([a, b]);
  });
});

describe('formatTime', () => {
  it('counts from the sample rate, not from a clock', () => {
    expect(formatTime(0, 48000)).toBe('0:00.000');
    expect(formatTime(48000, 48000)).toBe('0:01.000');
    expect(formatTime(48000 * 61.5, 48000)).toBe('1:01.500');
    expect(formatTime(44100 * 90, 44100)).toBe('1:30.000');
  });

  it('shows hours only once there are any', () => {
    expect(formatTime(48000 * 3600, 48000)).toBe('1:00:00.000');
    expect(formatTime(48000 * 3599, 48000)).toBe('59:59.000');
  });
});

describe('formatDb and formatBytes', () => {
  it('shows a floor rather than a run of minus signs', () => {
    expect(formatDb(-Infinity)).toBe('-∞');
    expect(formatDb(-200)).toBe('-∞');
    expect(formatDb(-12.34)).toBe('-12.3');
    expect(formatDb(0)).toBe('0.0');
  });

  it('scales bytes the way a person reads them', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 kB');
    expect(formatBytes(48000 * 4 * 32)).toBe('5.9 MB');
  });
});

describe('meterPosition', () => {
  it('pins the ends', () => {
    expect(meterPosition(0)).toBe(1);
    expect(meterPosition(-72)).toBe(0);
    expect(meterPosition(-200)).toBe(0);
  });

  it('gives the top of the scale most of the meter', () => {
    // The point of the curve: the region where the decision to turn something
    // down gets made must not be squeezed into a few pixels.
    expect(meterPosition(-24)).toBeGreaterThan(0.4);
    expect(meterPosition(-6)).toBeGreaterThan(0.8);
    expect(meterPosition(-60)).toBeLessThan(0.05);
  });

  it('never goes backwards', () => {
    let last = -1;
    for (let db = -72; db <= 0; db += 0.5) {
      const v = meterPosition(db);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
});

describe('panGains', () => {
  it('holds power constant across the sweep', () => {
    // A linear pan is 3 dB down in the middle, so every centred track sits
    // quieter than the ones pushed to a side. This is the check that it does
    // not.
    for (let pan = -1; pan <= 1; pan += 0.05) {
      const [l, r] = panGains(pan);
      expect(l * l + r * r).toBeCloseTo(1, 10);
    }
  });

  it('is -3 dB in the middle and full on the sides', () => {
    expect(panGains(0)[0]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(panGains(0)[1]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(panGains(-1)).toEqual([expect.closeTo(1, 10), expect.closeTo(0, 10)]);
    expect(panGains(1)).toEqual([expect.closeTo(0, 10), expect.closeTo(1, 10)]);
  });

  it('clamps rather than wrapping past the ends', () => {
    expect(panGains(-5)[0]).toBeCloseTo(1, 10);
    expect(panGains(5)[1]).toBeCloseTo(1, 10);
  });
});

describe('mixCoefficients', () => {
  const track = (input: number, patch: Partial<Track> = {}): Track => ({
    ...defaultTrack(input),
    ...patch,
  });

  it('maps by input number, not by position', () => {
    // A take of inputs 3 and 7 against an interface with sixteen. Matching by
    // position would put input 3's fader on input 7's audio.
    const tracks = [track(3, { pan: -1 }), track(7, { pan: 1 }), track(0)];
    const { left, right } = mixCoefficients([3, 7], tracks);
    expect(left[0]).toBeCloseTo(1, 6);
    expect(right[0]).toBeCloseTo(0, 6);
    expect(left[1]).toBeCloseTo(0, 6);
    expect(right[1]).toBeCloseTo(1, 6);
  });

  it('silences a muted track and nothing else', () => {
    const { left } = mixCoefficients([0, 1], [track(0, { muted: true }), track(1)]);
    expect(left[0]).toBe(0);
    expect(left[1]).toBeGreaterThan(0);
  });

  it('silences everything unsoloed once anything is soloed', () => {
    const tracks = [track(0), track(1, { soloed: true }), track(2)];
    const { left } = mixCoefficients([0, 1, 2], tracks);
    expect(left[0]).toBe(0);
    expect(left[1]).toBeGreaterThan(0);
    expect(left[2]).toBe(0);
  });

  it('brings mutes back exactly as they were when solo clears', () => {
    // The reason solo is evaluated rather than implemented by writing mutes:
    // a solo that muted the others would have to remember which were already
    // muted, and would eventually forget.
    const muted = [track(0, { muted: true }), track(1), track(2)];
    const before = mixCoefficients([0, 1, 2], muted).left;
    const soloed = muted.map((t, i) => (i === 2 ? { ...t, soloed: true } : t));
    mixCoefficients([0, 1, 2], soloed);
    const after = mixCoefficients([0, 1, 2], muted).left;
    expect([...after]).toEqual([...before]);
  });

  it('plays a channel with no matching track silent rather than at a guess', () => {
    const { left, right } = mixCoefficients([0, 9], [track(0)]);
    expect(left[1]).toBe(0);
    expect(right[1]).toBe(0);
  });

  it('applies gain in dB', () => {
    const { left } = mixCoefficients([0], [track(0, { gainDb: -6, pan: -1 })]);
    expect(left[0]).toBeCloseTo(Math.pow(10, -6 / 20), 6);
  });
});
