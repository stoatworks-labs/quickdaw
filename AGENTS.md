# AGENTS.md — bringing an LLM up to speed on QuickDaw

Orientation for an AI assistant (or a new human) picking this project up cold.
`CLAUDE.md` holds the short command reference; this file explains the model and
the traps.

---

## 1. What this is

A **multitrack audio recorder** that runs entirely in a browser tab. React +
TypeScript + Vite, built to a static `dist/` and served by a Cloudflare Worker
with static assets. No backend, no accounts, no telemetry.

Choose an audio interface and it gives you one track per input, mapped 1:1,
streamed to a folder on disk as mono WAVs. A continuous pre-roll buffer means
the take can start before the button was pressed. Takes recorded in the session
can be played back from the files, with a small mixer.

## 2. Layout

```
public/
  capture-worklet.js    AUDIO THREAD, write side. Plain JS, loaded by URL.
  playback-worklet.js   AUDIO THREAD, read side + mixer. Same rules.
  _headers              CSP, and the COOP/COEP pair the whole design needs.
src/
  types.ts              domain types and the settings shape. Read this first.
  store.ts              zustand settings + track list, persisted
  lib/
    ring.ts             THE FOUNDATION. Lock-free SPSC ring over a SAB.
    wav.ts              header build/patch, float32 and int24 conversion
    devices.ts          enumeration, probing, and the constraints that matter
    storage.ts          folder handles, OPFS, and filesystem-safe naming
    recorder.ts         the record engine: graph, ring, meters, wake lock
    player.ts           the playback engine
    mix.ts              gain/pan/mute/solo -> coefficients. Pure, so testable.
    format.ts           time, dB, bytes, and the meter's scale
  workers/
    writer.ts           ring -> files. One worker, one take, every track.
    reader.ts           files -> ring, ahead of the playback worklet.
  components/           Setup, Transport, TrackList, TakePanel
  App.tsx               wiring
```

**`ring.ts` is the whole design.** Everything else is arranged around it.

## 3. The one idea

There is a single `SharedArrayBuffer` per session holding every captured
channel, planar. The AudioWorklet writes into it on the audio thread; a Worker
reads out of it and writes to disk. Single producer, single consumer, no locks,
no allocation on the audio path, and one atomic store per render quantum.

**The producer never waits.** If the consumer falls behind by more than the ring
holds, the producer overwrites unread frames and carries on. A producer that
waited would stall the audio thread, which turns a disk hiccup into an audible
glitch and, on a live recording, into damage.

That choice is only defensible because of what the consumer does about it, which
is §5.

### Why not postMessage

The obvious build posts each render quantum from the worklet to the main thread.
At 48 kHz that is 375 messages a second, each carrying one `Float32Array` per
channel — twelve thousand allocations a second on a 32-channel interface, every
one of them garbage. The collector that eventually runs to clean them up runs on
a thread that is also trying to deliver audio. That *is* the buffer instability
this app exists to avoid, and no buffer size fixes it, because the problem is
the allocation rate rather than the buffer.

## 4. The pre-roll is not a separate buffer

The obvious implementation of a pre-roll keeps its own ring and, on record,
copies it into the file before switching to the live path. That copy is a burst
of hundreds of megabytes at the exact moment the take starts.

**There is no copy.** The pre-roll and the write buffer are one ring. Pressing
record starts the writer at a read position `preRollSeconds` in the past; it
then chases the producer forward as it would have anyway — through the pre-roll
first, because that is what is in front of it, and out into live audio when it
catches up.

Consequences worth knowing:

- Arming costs nothing. Capture runs from the moment the device opens.
- Turning the pre-roll off is only a smaller ring, not a different code path.
- Changing the pre-roll length **re-opens the device**, because the ring is
  allocated at open and cannot be resized under a running graph.
- The pre-roll is clamped twice: to what the ring physically holds less the
  write headroom, and to what has actually been captured since the device
  opened. A take started ten seconds in has ten seconds of pre-roll however many
  were asked for, and the file's start time stays true rather than being padded.

## 5. The trap: a gap must cost content, never time

When the producer laps the consumer, frames are gone. The tempting thing is to
write the surviving frames end to end.

**That is the bug.** It shortens every track by the size of the hole and pulls
everything after it early — identically on every track, so the result stays
perfectly in sync with itself while being wrong against the world. Nothing later
can detect it, and nothing in the file says it happened.

`writer.ts` instead pads the hole with exactly as many frames of silence as were
lost and records its position and length in `take.json`. The take keeps its
length, everything after the gap sits where it belongs, and the gap is a
documented fact.

`chain.test.ts` is the guard on this. It drives a producer and a consumer
against each other through deliberate stalls and asserts the take is the same
length as the time it covers with every surviving sample at its own position. If
you change the writer's accounting, that file is the one that matters.

## 6. Other things that will bite

### The app does not run without cross-origin isolation

`SharedArrayBuffer` requires `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. `public/_headers` sets them on the
deployed site and `vite.config.ts` sets them for dev and preview. **`_headers`
is not hardening here, it is load-bearing** — a deploy that loses it comes up
with a page that says it cannot run. There is deliberately no degraded fallback:
one would be a recorder that glitches, which is worse than one that refuses.

### Nothing about the audio hardware exists until permission is granted

A browser will not describe the machine's audio devices to a page that has never
been allowed a microphone. Chrome does not signal that with an empty list — it
returns one placeholder entry per kind with an **empty `deviceId`** and an empty
label. That entry cannot be opened: `deviceId: { exact: '' }` matches nothing.

`listDevices` filters those out, so an empty result means exactly one thing:
there is nothing selectable yet, and the caller must call `requestAccess` from a
user gesture and list again. `Setup` shows an "Allow microphone access" button
in place of the picker whenever the list is empty.

**This was a deadlock, not a cosmetic gap.** The placeholder rendered as a
pickable option whose value was the empty string — the same value as the "choose
a device" placeholder — so selecting it was indistinguishable from selecting
nothing, `chooseDevice` returned early on `if (!id)`, `getUserMedia` was never
called, the prompt never appeared, and the list could therefore never be
populated. The app shipped looking completely inert with no way out of it.
`devices.test.ts` pins the filter.

`requestAccess` asks for `{ audio: true }` and nothing else, then stops the
stream immediately. Constraining it to a device or a channel count can fail on
its own merits and report itself as a permission problem, which sends people
looking in entirely the wrong place.

### Capture constraints must all be off

`echoCancellation`, `noiseSuppression` and `autoGainControl` default to *on*,
because the default caller of `getUserMedia` is a video call. Automatic gain in
particular will ride a take's level up and down for its whole length. They are
switched off explicitly, and `describeProcessing` reads `getSettings()` back to
see whether the browser agreed — a constraint accepted and then not applied
looks exactly like one that was honoured.

### The worklet node must be `discrete`, not `speakers`

`channelInterpretation: 'discrete'` on the `AudioWorkletNode`. The default,
`'speakers'`, applies the up/down-mix rules, which for anything above two
channels means the browser folding a 16-input interface into a surround layout
and handing the worklet a mix rather than the inputs.

### `source.channelCount` is not the channel count

`AudioNode.channelCount` is an **input**-side mixing property. A source node has
no inputs, so on a `MediaStreamAudioSourceNode` it reads **2 regardless of how
many channels the stream carries** — the output width comes from the track, not
from this. An early version clamped with
`Math.min(open.channels, source.channelCount)`, which silently capped every
interface at two inputs no matter what was plugged in.

`track.getSettings().channelCount` is the authority, and `openDevice` already
reads it. A `ChannelMergerNode` makes the same point loudly rather than
silently: its `channelCount` is fixed at 1 and cannot be assigned, while its
output has as many channels as it has inputs — which is how this was found.

### The context is created at the device's rate

The device is opened twice: once to be interrogated (a `MediaStreamTrack` is the
only thing that will say how many channels and what rate), then for real. The
`AudioContext` is constructed at the rate that probe reported. Any other rate
puts a resampler in front of every sample before the recorder sees it.

`latencyHint` is `'playback'` — the *largest* buffers the browser will give.
Nothing is waiting on the input, so this is pure margin.

### Time never stops in the worklet

If the input goes away, `inputs[0]` arrives empty. The processor still advances
the write pointer by a full quantum of silence. Not advancing would be far
worse: the recording would omit the missing time, so every track would end up
shorter than the take and everything after the interruption would sit early.

### The meter bridge and the track rows must agree

Both draw the same signal, so both read `meterPosition` for the geometry and
`lib/theme.ts` for the colours and the banding. Do not give either its own
scale or its own palette: two meters that nearly agree read as a fault in one of
them, and a grid drawn at even spacing over bars that use a curve produces a
meter that looks precise and lies.

`SCALE_MARKS.map(meterPosition)` is a trap worth knowing — `map` passes the
index as the second argument, which `meterPosition` takes as its dB floor. Call
it through an arrow.

### The engines live outside React

`Recorder` and `Player` are plain classes with module-level instances.
Components read their buffers inside `requestAnimationFrame` and write numbers
straight into DOM nodes; levels and the playhead never pass through React state.
Thirty-two channels at the display rate is around two thousand state updates a
second.

Two specific consequences: `getComputedStyle` is read **once** in the meter
effect and not per frame (it forces a style recalculation, and per-channel
per-frame is enough on its own to make the meters stutter), and the clip latch
is cleared through `recorder.clipGeneration` rather than by React, because the
loop that sets the class must be the loop that clears it.

### `write()` does not copy the chunk it is handed

`FileSystemWritableFileStream.write()` queues the chunk and is not required to
have copied it by the time it returns. `writer.ts` therefore keeps **one encode
buffer per track**, not one shared. A shared buffer reused for the next track
can be pulled out from under a write that has not run yet — which corrupts a
file only under load, and never in a short test.

### Files appear at `close()`, not during the take

Chrome stages a streamed write in a swap file and moves it into position at
close. A tab killed mid-take leaves nothing behind. The UI says so; do not
"fix" it by closing and reopening the writable periodically, which rewrites.

### Do not put literal control characters in a regex

`safeName` removes control characters by comparing code points rather than with
a range inside a character class. That is not stylistic: the class carried a
*literal* NUL and a literal 0x1f during development. It looked identical to the
intended `* -` in an editor, matched something entirely different, and was
invisible to review. `naming.test.ts` is what caught it.

## 6b. The generated source

`lib/testsignal.ts` builds eight channels of tone in the page and
`Recorder.open` takes it instead of `getUserMedia` when the device id is
`TEST_DEVICE_ID`. Everything downstream is identical — the same worklet, ring,
writer and files — so it is a check rather than a demonstration, and a take made
from it exercises what a real take does.

It needs **no microphone permission**, which is the point: the app is never a
dead end for someone with no interface or a refused prompt. It is listed
**last**, so nobody reaches for it by accident.

**Input 1 is a reference, not decoration**: 1 kHz at exactly -18 dBFS, and
deliberately unmodulated. It is the one number on screen that can be checked
against an expectation, and `testsignal.test.ts` pins it along with the rule
that no channel — tremolo included — may reach full scale, because a source
offered as a check must never light the clip indicator by itself.

## 7. How to verify a change

There is no synthetic source to check against, the way simpleRTA has pink noise
— a recorder's correctness is about time and files, not spectra. So:

1. **`npm test`.** `chain.test.ts` is the one that matters for anything touching
   the ring, the writer or the pre-roll.
1b. **Pick the test signal and read input 1.** It must say -18.0. No hardware,
   no permission, two seconds, and it exercises the whole capture path.
2. **Record a take and look at the buffer readout.** The fill bar should sit
   near the bottom and the "peak buffer" figure should stay low. A rising bar is
   the disk, not the audio.
3. **Check the take is the length it should be.** A stopwatch is enough. This is
   the single most useful manual check, because every interesting failure mode
   shows up as a take that is the wrong length.
4. **Open the files in a DAW and check the tracks line up.** They are written
   from one read position, so they cannot drift from each other — but that is
   the claim being checked.
5. **With the pre-roll on, make a noise, wait, then press record.** The noise
   should be in the file, at the offset you left it at.

## 8. Deliberately not here

- **No editing.** It records and it plays back. Not a DAW.
- **No punch-in, loop record, or arming during a take.**
- **No 16-bit**, because undithered 16-bit is the wrong default to hand someone
  who did not think about it.
- **No pink noise or sweep in the test signal.** Tones only. Noise would be the
  better source for checking a *filter*, and there is no filter here — what this
  app has to show is that eight discrete channels arrive at distinct, correct
  levels, which tones say more clearly.
- **No OPFS export path yet.** `storage.ts` can reach the origin private file
  system and the writer would work against it, but nothing in the UI offers it
  or exports from it — so on a browser without the File System Access API the
  app currently has nowhere to record to and says so. See `docs/NOTES.md`.
- **No calibrated levels.** Everything is dBFS. There is no reference and no
  offset field, and the app makes no SPL claim.

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
