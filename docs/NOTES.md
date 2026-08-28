# QuickDaw — working notes

Repo-local notes: current status, decisions already made, and the traps that
have actually bitten. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

---

## Status, 2026-08-28

First build. Everything described in the README exists, the test suite passes
(56 tests), and both AudioWorklets plus the file-writing API have been driven in
a real Chrome. **Nothing has been run against a real multichannel interface.**

### Verified in-browser, 2026-08-28 (Chrome, dev server)

Driven directly from the page rather than through the UI, because this machine
has no audio input device — an oscillator into a `ChannelMerger` stands in for
an interface.

- **Capture worklet.** Three tones at 0.5 / 0.25 / 0.125 into three discrete
  channels came out of the ring at exactly those amplitudes, so
  `channelInterpretation: 'discrete'` is doing its job and nothing is being
  folded. Meter peaks matched exactly and the RMS values were 0.354 / 0.177 /
  0.088 — amplitude over root two, to three places, on all three. No false
  clips, no silent frames, `CTRL_STARTED` set.
- **`latencyHint: 'playback'` is honoured.** `baseLatency` came back as
  21.3 ms — 1024 frames at 48 kHz, which is the large buffer that was asked for
  rather than the interactive default.
- **Playback worklet and mixer.** Centred at unity, three DC channels of 0.1 /
  0.2 / 0.4 summed to 0.4950 against an expected 0.4950. Hard-panned with the
  middle channel muted, the left/right ratio was exactly 0.25 = 0.1 / 0.4. All
  coefficients zero produced true silence. Clearing `CTRL_RUN` stopped
  consumption dead — the read position did not advance by one frame — which is
  what makes a seek safe.
- **The underrun path, by accident.** Two readings came back at exactly 15/16 of
  their expected value: 128 frames of a 2048-sample analyser window, which is
  one render quantum of silence from the crude JS refill loop falling behind.
  The worklet did the right thing — emitted silence, counted it in
  `CTRL_SILENT`, and kept its timing — and the arithmetic elsewhere in the same
  window was exact.
- **Seeking back to patch a WAV header.** The riskiest API assumption in the
  whole design, since RIFF declares its length in its first bytes and a recorder
  does not know that length until stop. Against a real
  `FileSystemWritableFileStream` in OPFS: header written with zeroed sizes,
  48 kB of audio streamed in chunks, then positions 4, 44 and 52 patched by
  seeking backwards over data already written. Every size field came back
  correct, the audio was **bit-exact** afterwards (worst error 0.0), and
  Chrome's own `decodeAudioData` accepted the file — 12000 frames, 48 kHz, mono,
  right sample values.

### What that still leaves unproven

- **Channel count.** Chrome supports multichannel input, but how many channels a
  given driver offers a browser is the driver's decision. `openDevice` asks for
  64 as an *ideal* and reports what came back; whether a 16- or 32-input
  interface actually presents all of them here is unknown.
- **Sample-rate matching.** The context is created at the rate the probe
  reported. Whether Chrome honours that on every device, or quietly resamples,
  has not been observed.
- **Long takes.** Nothing has run for hours. The 32-bit frame counter wraps at
  24.8 hours (48 kHz) and `unwrapPosition` is tested for it, but the 4 GB RIFF
  ceiling at about six hours per track has only been reasoned about.
- **Throughput.** The ring's behaviour under a stall is tested by simulation.
  What a real disk does with 32 concurrent `FileSystemWritableFileStream`s at
  6 MB/s has not been measured. The buffer-health readout exists precisely so
  that first session produces a number rather than an impression.
- **`getUserMedia` at all.** There is no audio input device on this Mac, so the
  device picker, the probe/re-open sequence, the constraint read-back and the
  `ended` handler have never run against a real stream. Everything downstream of
  the worklet's input is verified; the path *into* it is not.
- **The writer and reader Workers end to end.** Their arithmetic is unit-tested
  and the API they depend on is verified above, but no take has been written by
  the actual worker to an actual folder and played back.

The first hardware session is where the real bugs are, as ever. Word the
README's disclaimer so it can be replaced rather than rewritten when that
happens.

## Decisions already made

**No SharedArrayBuffer fallback.** The app refuses to run rather than degrading
to postMessage. A fallback would allocate per quantum per channel, which is the
exact instability the app exists to avoid — a recorder that glitches is worse
than one that says it cannot run here.

**One mono WAV per track, not one interleaved file.** Every DAW imports it, a
track can be disarmed without disturbing the others, and an interrupted take
still leaves the completed tracks readable.

**No 16-bit.** Needs dither to be done properly, and dither at record time is a
decision that belongs at the end of a chain.

**Cloudflare Worker, not Pages.** Fleet standard —
`[assets] directory = "./dist"`, not `pages_build_output_dir`. See the
[cloudflare access](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_cloudflare_access.md)
note for why, and for the failure mode when the wrong key is used.

## Traps that have already bitten

### A literal control character inside a character class

`safeName`'s regex was written as `[<>:"/\\|?* -]` and arrived on disk as
`[<>:"/\\|?*` + NUL + `-` + 0x1f + `]` — a control-character *range*, which
looks identical in an editor and matches something entirely different. It passed
typecheck, passed lint, and produced a filename rule nobody had chosen.
`naming.test.ts` caught it: a test asserting `Room L` became `Room-L` failed,
which is how the raw bytes were found at all.

The function now strips control characters by comparing code points, and keeps
spaces. **Do not put a literal control character in source.** If a range is
genuinely wanted, an escape is the only acceptable form, and a test has to pin
what it matches.

### `write()` does not copy synchronously

`FileSystemWritableFileStream.write()` queues the chunk it is handed. The first
version of `writer.ts` shared one encode buffer across every track, which can be
overwritten while an earlier track's write is still pending. It would have
corrupted files only under load. One buffer per track now.

### `useSyncExternalStore` with a local counter never fires

`useEngineVersion` first held its version in a `let` inside the hook. A local is
reinitialised on every render, so `getSnapshot` returned the same value for ever
and the component subscribed to an engine it then never re-rendered for. It is a
`useRef` now.

### `getComputedStyle` per canvas per frame

The meter loop originally read the theme colours off each canvas on every frame.
`getComputedStyle` forces a style recalculation; thirty-two channels at 60 fps is
around two thousand a second, which is enough on its own to make the meters
stutter on a page whose whole point is that nothing stutters. Read once, on
mount.

### The device picker could never be used at all

Found 2026-08-28, on the deployed site, by Allan: the app loaded and then would
neither ask for microphone permission nor let a device be selected.

Before permission is granted, `enumerateDevices()` returns a placeholder entry
with an empty `deviceId` and an empty label rather than an empty list. Nothing
filtered it, so it was rendered as an `<option>` whose value was `''` — the same
value as the "choose an audio input…" placeholder. Selecting the device was
therefore literally the same event as selecting nothing, `chooseDevice`'s
`if (!id) return` swallowed it, and since the only thing that triggers a
permission prompt is asking for a stream, the prompt could never fire and the
list could never fill in. A closed loop with no way out from inside the UI.

The `chooseDevice` comment even said "labels are empty until permission has been
granted once" — the label problem was known and handled; that the **deviceId**
is also empty was not, and that is the half that broke it.

Two things came out of it beyond the fix:

- The permission state is now tracked through `navigator.permissions`, including
  its `change` event, so revoking access in site settings empties the picker
  rather than leaving entries that can no longer be opened.
- `getUserMedia` failing is not one condition. `NotFoundError` means nothing is
  plugged in; `NotAllowedError` means refused. Reporting both as "denied" sends
  someone to the padlock menu to fix a machine with no interface connected.

Also fixed in the same pass: the track rows were rendered from the persisted
store, so a reload showed a full track list — with meters that could never move
— on a page with no device open. Names and mix settings still persist; the rows
are now gated on the open device's channel count.

### `source.channelCount` capped every interface at two inputs

Found 2026-08-28 while building the meter bridge, and it would have made the
whole app useless on any real interface.

`recorder.open()` decided the channel count with
`Math.min(open.channels, source.channelCount || open.channels)`. That looks like
sensible defensiveness — take the smaller of what the track claims and what the
node reports — and it is wrong, because `AudioNode.channelCount` is an
**input**-side mixing property. A source node has no inputs. On a
`MediaStreamAudioSourceNode` it reads 2 whatever the stream carries, so a
16-input interface would have produced two tracks, quietly, with no error.

It surfaced only because the synthetic source used to test the meters is a
`ChannelMergerNode`, whose `channelCount` is fixed at 1 and **throws** when
assigned. The same wrong assumption fails loudly there and silently on the real
path. Without a multichannel interface to hand, that throw was the only thing
that was ever going to catch it.

`track.getSettings().channelCount` is the authority. There is still no test for
this — it needs a real multichannel stream, which is the first thing to check in
the hardware session.

### A new custom domain looks exactly like a failed deploy for 30 minutes

First deploy, 2026-08-28. `wrangler deploy` reported success and attached
`quickdaw.stoatworks-labs.com`, every asset served HTTP 200 with the right
sizes and content types — and the site would not load in a browser on this Mac.

The cause was a **negatively cached DNS answer**. Something looked the hostname
up in the seconds around the record being created, got NXDOMAIN, and macOS's
`mDNSResponder` held that answer. The zone's SOA minimum is **1800 seconds**, so
the wrong answer outlives the deploy by half an hour.

What makes it hard to spot is that `dig` says everything is fine. `dig` talks to
the resolver directly and bypasses the OS cache; `getaddrinfo` — which is what
curl, every browser and everything else actually uses — does not. The two
disagreeing is the signature:

```
dig +short quickdaw.stoatworks-labs.com          -> 104.21.84.34 172.67.185.208
python3 -c "import socket; socket.getaddrinfo('quickdaw.stoatworks-labs.com',443)"
                                                 -> nodename nor servname provided
```

Diagnose by comparing those two, and by fetching the origin with the resolver
stepped over entirely:

```bash
curl -sI --resolve 'quickdaw.stoatworks-labs.com:443:104.21.84.34' \
  https://quickdaw.stoatworks-labs.com/
```

A 200 there means the deploy is fine and the problem is local. The fix is to
flush the cache (needs a password, so a human runs it) or to wait out the 1800
seconds:

```bash
sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder
```

**Do not redeploy in response to this.** Nothing about a redeploy touches the
cached answer, and the deploy was never the problem.

### "Opening the device…" for ever

Found 2026-08-28 while taking the release screenshot with headless Chrome.

`open()` awaited `ctx.resume()`. Without a user gesture Chrome does not reject
that promise — it leaves it pending indefinitely — so `open()` never returned,
`busy` stayed true, and the app sat on "Opening the device…" with no error
anywhere. A hang with no diagnostic is the worst shape a failure can have, and
this one is invisible in normal use because choosing from a `<select>` is itself
a gesture.

Bounded now, with the graph built regardless and a one-shot listener that
resumes on the next interaction. Reachable outside automation too: a restored
tab, or a page opened in a background tab, starts suspended the same way.

## The generated test signal, added 2026-08-28

Offered twice and declined by silence, then added when it became load-bearing:
the release needed screenshots, a hero image, a thumbnail and a video, and every
one of them is a picture of the app doing its job. With nothing plugged in, that
picture is an empty meter bridge.

It earns its place beyond that. It is the only way to check the recorder before
trusting a session to it, it needs no permission so the app is never a dead end,
and input 1 is a real alignment tone at a real alignment level, which turns "do
the meters work" into a number rather than an impression.

Worth remembering for the next project: **a tool with no synthetic source cannot
be photographed, filmed, or checked by anyone who does not already own the
hardware.** simpleRTA had pink noise from the start and its video was
straightforward for exactly that reason.

## Follow-ups, deliberately not done yet

- **`about-data.js` is a hand-written placeholder.** Every other repo's copy is
  generated by `stoatworks-backend/scripts/sync-about.py` from the website's
  `projects.json`. QuickDaw has no entry there yet, so there was nothing to
  generate from. Add the entry, run the sync, and this file stops being anyone's
  to edit. The same applies to `.github/ISSUE_TEMPLATE/` — the files match the
  masters but were placed by hand, and `sync-issue-templates.py` (public repos
  only) should be run once the repo is public to reconcile them.
- **OPFS is reachable but not offered.** `storage.ts` has `opfsRoot()` and the
  writer would work against it, but nothing in the UI selects it and there is no
  export path out of it. Until that exists, a browser without the File System
  Access API has nowhere to record to. Worth doing only if there is a real
  reason to support Firefox or Safari, which cannot do multichannel input
  reliably anyway.
- **No waveform overview on a take.** The scrubber is a plain range input. A
  peak file written alongside the audio during the take would be nearly free —
  the writer already has every sample in hand — and is the obvious next thing if
  playback gets used in anger.
- **No release yet.** No tag, no `projects.json` entry, no user guide, no video.
  See the release checklist in `stoatworks-backend/release/` before cutting one;
  the guide is part of a release, not a separate job.
