# QuickDaw

> **AI-assisted project.** This codebase was created with [Claude Code](https://claude.com/claude-code)
> (Anthropic), directed and reviewed by a human author. The buffer arithmetic is verified
> numerically — 56 tests pin the ring's behaviour across its 32-bit wrap and through an overrun,
> the WAV headers byte by byte, the 24-bit conversion against its own quantisation step, and the
> mixer's solo and pan rules — and the central invariant, that a take is the same length as the
> time it covers with every sample at the position it was captured at, is tested by driving a
> producer and a consumer against each other through deliberate stalls. Both AudioWorklets have
> been driven in a real browser from a synthetic source — which is how a bug that would have capped
> every interface at two inputs was found — and the header-patching the file format depends on has
> been checked against the real filesystem API, coming back bit-exact and readable by the browser's
> own decoder. It has **not** been run against a real multichannel interface, or
> against a microphone at all: the channel mapping, the sample-rate matching, the disk throughput
> and the long-take behaviour are correct by construction and by test, and unproven against
> hardware.

A multitrack audio recorder that runs entirely in a browser tab. Choose an interface, and QuickDaw
gives you one track per input, mapped 1:1, streamed straight to a folder on your disk as WAV.

**[quickdaw.stoatworks-labs.com](https://quickdaw.stoatworks-labs.com)**

- **One track per input.** The interface's channel count is read from the device and the track
  list is built from it. Name the tracks, disarm the ones you do not want.
- **Pre-roll buffer.** With it on, every input is held continuously — 30 seconds by default, up to
  two minutes. Pressing record puts the audio from *before* the button at the head of the take.
- **Straight to disk.** Takes stream to a folder you choose, one mono WAV per track plus a
  `take.json`. Nothing is held in memory waiting for a stop.
- **32-bit float or 24-bit**, at the interface's own sample rate, with no resampling and none of
  the browser's voice processing.
- **Metering before you commit to anything.** A meter bridge across every input, live from the
  moment the interface opens — before arming, before recording — with peak, RMS, peak hold, a
  latching clip flag and a dB scale. Each track row carries its own meter and numeric readout for
  setting a level on one input.
- **Playback** of any take in the session, streamed from the files, with per-track gain, pan, mute
  and solo.

No backend, no accounts, no telemetry. The audio goes from the interface to your folder and never
leaves the machine.

---

## The pre-roll

The thing a recorder is for is the take you did not press record in time for.

With the pre-roll on, every input is being captured from the moment the device opens. The buffer
holds the last N seconds; when you press record, the take begins N seconds ago. There is no arming
step and no copy — the writer simply starts reading at a position that is already in the past, and
chases forward from there.

The cost is memory, and it is not small: one second of held audio is `sample rate × channels × 4`
bytes, so 30 seconds of a 16-input interface at 48 kHz is 92 MB, and two minutes of 32 inputs at
96 kHz is 1.5 GB. The figure for your interface is shown next to the control before you commit to
it.

If you press record before the buffer has filled, the take starts at the earliest audio that
exists rather than padding the difference with silence — the file's start time stays true.

## What lands on disk

```
QuickDaw 2026-08-28 14-32-05/
  01 Kick.wav
  02 Snare.wav
  03 Room L.wav
  take.json
```

One mono WAV per track, which is what every DAW imports without asking questions, and what lets a
single track be disarmed without disturbing the others. `take.json` records the sample rate, the
format, the length, how much of the head is pre-roll, and — if there were any — where the gaps
are.

**Files appear when the take stops.** The browser stages a streamed write and moves it into place
at close; the take is on disk the whole time but is not visible as the file until then, and a tab
that is killed mid-take leaves nothing behind. That is the price of the single-pass write, and it
is the same for every browser-based recorder that streams to a folder.

## Gaps, and why they are silence rather than nothing

If the disk stalls for longer than the buffer holds, frames are lost. Nothing can prevent that.
What QuickDaw does about it is refuse to hide it:

- the lost frames are replaced by exactly as many frames of **silence**, so the take keeps its
  length and everything after the gap stays where it belongs;
- the position and size of each gap goes into `take.json` and is shown on the take in the app.

The alternative — writing the surviving frames end to end — shortens the take and drags everything
after the gap early. It does so identically on every track, so the result stays perfectly in sync
with itself while being wrong against the world, which is the failure you cannot find afterwards.

The buffer readout during a take shows how full the ring is, the worst it has been, the slowest
single disk write, and the frame count if anything has been lost. If that bar is not near the
bottom, the disk is the problem.

## Requirements

**Chrome or Edge**, on a desktop. Two things gate it:

- **The File System Access API**, for streaming a take into a folder you choose. Firefox and
  Safari do not have it.
- **Cross-origin isolation**, which is what a browser requires before it will hand out a
  `SharedArrayBuffer`. Every buffer here is one — the audio thread writes into shared memory and a
  worker reads it — so without it the app says so and stops rather than falling back to something
  that glitches. The deployed site sends the headers; so do `npm run dev` and `npm run preview`.

Multichannel input above two channels is a Chrome capability, and how many channels a given
interface offers a browser is up to the driver. QuickDaw asks for everything and reports what it
was given.

## What it is not

- **Not a DAW.** No editing, no arrangement, no plugins, no overdubbing to an existing take. It
  records and it plays back.
- **No punch-in, no loop recording, no track arming during a take.** The armed set is fixed at the
  moment record is pressed, because changing it means opening a file mid-recording and that track
  starting late against every other one.
- **No 16-bit.** Truncating to 16 bits properly needs dither, and dither at record time is a
  decision that belongs at the end of a chain rather than the start.
- **Not low-latency.** The opposite, deliberately: the audio context asks for the largest buffers
  the browser will give, because nothing is waiting on the input and a bigger buffer is a bigger
  margin. Monitoring through the app is available and is not the way to monitor a live source.

## Development

```bash
npm install
npm run dev          # vite dev server, with the isolation headers
npm test             # vitest — 56 tests
npm run build        # tsc -b && vite build -> dist/
npm run lint         # oxlint
```

`AGENTS.md` explains the model and the traps; `docs/NOTES.md` carries the working notes.

## Licence

MIT.
