/**
 * The mixer's arithmetic: gain, pan, mute and solo collapsed into one pair of
 * coefficients per track.
 *
 * Separate from `player.ts` because it is pure — no AudioContext, no worklet
 * URL, nothing that needs a document — so it can be tested directly. Solo in
 * particular is a rule that is easy to get subtly wrong and impossible to
 * notice until a track is missing from a playback in front of someone.
 */

import type { Track } from '../types';

/**
 * Equal-power pan.
 *
 * A linear pan is 3 dB down in the middle, which on a multitrack mix means
 * every centred track sitting quieter than the ones pushed to a side. The
 * trigonometric form holds the power constant across the sweep, so moving a
 * track across the image changes where it is and not how loud it is.
 */
export function panGains(pan: number): [number, number] {
  const a = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

/**
 * Build the coefficient pair for each ring channel, in ring-channel order.
 *
 * `order` is the take's track list, which is the *armed* inputs at the time it
 * was recorded — not necessarily every input on the interface, and not
 * necessarily contiguous. The current track list may well be longer, or have
 * been renamed since. Matching by input number rather than by position is what
 * keeps a mix pointing at the track it was set for.
 *
 * Solo is exclusive-by-presence: if anything is soloed, everything not soloed
 * is silent. That is not the same as muting everything else — clearing the solo
 * has to bring the previous mutes back exactly as they were, which it does
 * here because mute is never written to.
 */
export function mixCoefficients(
  order: number[],
  tracks: Track[],
): { left: Float32Array; right: Float32Array } {
  const anySolo = tracks.some((t) => t.soloed);
  const left = new Float32Array(order.length);
  const right = new Float32Array(order.length);

  for (let i = 0; i < order.length; i++) {
    const t = tracks.find((x) => x.input === order[i]);
    // A channel with no track — the take has an input the interface no longer
    // offers — plays silent rather than at some default gain. Inventing a level
    // for a track nobody has a control for is worse than leaving it out.
    if (!t || t.muted || (anySolo && !t.soloed)) continue;
    const g = Math.pow(10, t.gainDb / 20);
    const [l, r] = panGains(t.pan);
    left[i] = g * l;
    right[i] = g * r;
  }
  return { left, right };
}
