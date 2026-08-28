/**
 * A signal generated in the page, so the recorder can be proved without hardware.
 *
 * The same idea as simpleRTA's pink noise, and it exists for the same reason:
 * before you trust a tool with a session, you want to have seen it work. Here
 * that means meters that move, a take that records, and a take that plays back
 * — none of which can be checked with nothing plugged in, and all of which are
 * exactly what you want to have checked *before* the interface arrives.
 *
 * It runs through the whole real chain. The generator is an ordinary set of
 * `AudioNode`s feeding the same capture worklet, the same ring, the same writer
 * and the same files as a live interface. Nothing about the recorder knows this
 * source is synthetic, so a take made from it exercises everything a real take
 * does — which is what makes it a check rather than a demonstration.
 *
 * It also needs **no microphone permission**, because it never asks for a
 * stream. That matters more than it sounds: it means the app is never a dead
 * end. Someone who lands on it with no interface, or who has refused the
 * permission prompt, can still see what the thing does.
 *
 * ## Channel 1 is a reference, not decoration
 *
 * A steady 1 kHz sine at exactly -18 dBFS. That is a real alignment tone at a
 * real alignment level, so the meters can be checked against a number rather
 * than admired: input 1 must read -18. If it does not, the fault is in the
 * metering or the gain staging, and this is the fastest way to find that out.
 *
 * The rest are there to look like eight different sources — tones an octave
 * apart, at descending levels, each breathing on its own slow tremolo so the
 * bridge shows movement rather than eight static bars.
 */

/** Inputs the generated source presents. Enough to look like an interface. */
export const TEST_CHANNELS = 8;

/** Channel 1's reference level, in dBFS. A meter that disagrees is wrong. */
export const REFERENCE_DB = -18;

/** Channel 1's reference frequency, in Hz. */
export const REFERENCE_HZ = 1000;

const dbToGain = (db: number) => Math.pow(10, db / 20);

export interface TestChannel {
  hz: number;
  db: number;
  /** Tremolo rate in Hz. 0 on the reference, which must not move. */
  tremoloHz: number;
}

/**
 * What each generated channel is, as data.
 *
 * Separated from the graph so the levels can be asserted without an
 * AudioContext. The reference is a claim the app makes on screen — input 1
 * reads -18 — and a claim worth testing is worth being able to test cheaply.
 */
export function testChannelPlan(): TestChannel[] {
  const plan: TestChannel[] = [
    { hz: REFERENCE_HZ, db: REFERENCE_DB, tremoloHz: 0 },
  ];
  for (let i = 1; i < TEST_CHANNELS; i++) {
    plan.push({
      // Octaves down from 880 Hz, so the tones are distinguishable by ear as
      // well as by eye if anyone monitors this.
      hz: 880 / Math.pow(2, (i - 1) / 2),
      // A staircase, so the bridge shows a range of levels rather than eight
      // bars at the same height.
      db: -12 - (i - 1) * 6,
      tremoloHz: 0.13 + i * 0.07,
    });
  }
  return plan;
}

export interface TestSource {
  node: AudioNode;
  /** Stops every oscillator. The nodes are unusable afterwards. */
  stop: () => void;
}

/**
 * Build the generator.
 *
 * Returns a node with `TEST_CHANNELS` discrete output channels, ready to be
 * connected to the capture worklet exactly as a `MediaStreamAudioSourceNode`
 * would be.
 */
export function createTestSource(ctx: AudioContext): TestSource {
  const merger = ctx.createChannelMerger(TEST_CHANNELS);
  const started: OscillatorNode[] = [];
  const now = ctx.currentTime;

  for (const [i, ch] of testChannelPlan().entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = ch.hz;
    const base = dbToGain(ch.db);
    gain.gain.value = base;

    if (ch.tremoloHz > 0) {
      // Slow, independent tremolo. The depth is proportional to the channel's
      // own level, so it is a breath around that level rather than something
      // that swamps the staircase and makes every input look the same.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = ch.tremoloHz;
      const depth = ctx.createGain();
      depth.gain.value = base * 0.4;
      lfo.connect(depth).connect(gain.gain);
      lfo.start(now);
      started.push(lfo);
    }

    osc.connect(gain).connect(merger, 0, i);
    osc.start(now);
    started.push(osc);
  }

  return {
    node: merger,
    stop: () => {
      for (const o of started) {
        try {
          o.stop();
        } catch {
          // Already stopped, or the context is closing. Nothing to do about it
          // and nothing that depends on it.
        }
      }
    },
  };
}
