/**
 * Finding an interface, and opening it without the browser getting in the way.
 *
 * ## The three constraints that must be off
 *
 * `echoCancellation`, `noiseSuppression` and `autoGainControl` are on by default
 * in every browser, because the default caller of `getUserMedia` is a video
 * call. All three are gain- and spectrum-shaping processors, and automatic gain
 * in particular will ride a recording's level up and down for the whole take.
 * Leave any of them on and what lands on disk is the browser's voice pipeline
 * rather than what the interface converted. They are switched off explicitly
 * here, and `describeProcessing` reports back whether the browser agreed —
 * because a constraint the browser silently declined looks exactly like one it
 * honoured.
 *
 * ## Why the device is opened twice
 *
 * A `MediaStreamTrack` is the only thing that will say how many channels a
 * device has and what rate it runs at; `enumerateDevices` gives a label and an
 * id and nothing else. So the device is opened once with permissive
 * constraints purely to be interrogated, closed, and then opened for real at
 * the channel count it admitted to.
 *
 * That matters because the AudioContext has to be created at the device's own
 * rate. Create it at any other and the browser inserts a resampler in front of
 * every sample the recorder sees, which costs quality for nothing — the take is
 * going to a file, not to a converter that cares what rate it is.
 */

import type { DeviceInfo } from '../types';

/**
 * Channels to ask for when probing.
 *
 * `ideal` rather than `exact`: an `exact` count above what the device has is an
 * `OverconstrainedError` and no stream at all, whereas an ideal one gets
 * whatever the device can give and lets us read it back. 64 is past any
 * interface a browser will open and costs nothing when the answer is 2.
 */
const PROBE_CHANNELS = 64;

/**
 * The constraint set. Every recording opens with exactly this.
 *
 * `latency` is an ideal rather than a requirement, and is deliberately *large*.
 * QuickDaw is a recorder: nothing is waiting on the input, so the browser is
 * free to use the biggest input buffer it likes, and a bigger buffer is a
 * bigger margin against a scheduling hiccup turning into a hole in the take.
 * Chrome treats this as advisory and may ignore it entirely; it is asked for
 * because it can only help, not because it is relied on.
 */
export function captureConstraints(deviceId: string | null, channels: number): MediaStreamConstraints {
  // `latency` is in the Media Capture spec but not in TypeScript's DOM lib, so
  // it needs the cast. Dropping it instead would cost the one hint we can give
  // the browser about how big an input buffer to use.
  const audio: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: channels },
    latency: { ideal: 0.05 },
  } as MediaTrackConstraints & { latency: ConstrainDouble };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

export interface OpenResult {
  stream: MediaStream;
  track: MediaStreamTrack;
  channels: number;
  sampleRate: number;
  /** Constraints the browser did not honour, by name. Empty is the good case. */
  ignored: string[];
}

function readTrack(track: MediaStreamTrack): { channels: number; sampleRate: number } {
  const s = track.getSettings();
  const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : undefined;
  // getSettings is the authority on what we actually got. getCapabilities is
  // only consulted when the setting is missing, which some browsers do for
  // channelCount on a device they consider mono.
  const channels = s.channelCount ?? (caps?.channelCount?.max as number | undefined) ?? 1;
  const sampleRate = s.sampleRate ?? 0;
  return { channels: Math.max(1, channels), sampleRate };
}

/**
 * Which of the processing constraints the browser declined.
 *
 * A browser is allowed to accept a constraint and then not apply it, and
 * `getSettings` is where that shows. Anything named here is being applied to
 * the recording whether we asked for it or not, and the app says so rather than
 * letting someone find out from the files.
 */
export function describeProcessing(track: MediaStreamTrack): string[] {
  const s = track.getSettings() as MediaTrackSettings & {
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  };
  const ignored: string[] = [];
  if (s.echoCancellation === true) ignored.push('echo cancellation');
  if (s.noiseSuppression === true) ignored.push('noise suppression');
  if (s.autoGainControl === true) ignored.push('automatic gain');
  return ignored;
}

export type MicPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/**
 * Ask for microphone access, purely to unlock the device list.
 *
 * The stream is stopped the instant it arrives: this is not a capture, it is
 * the only way a page is allowed to learn what audio hardware exists. Must be
 * called from a user gesture — a browser will refuse a prompt that is not
 * attached to one, and the refusal is indistinguishable from the user saying
 * no.
 *
 * Deliberately unconstrained. Asking for a specific device or channel count
 * here can fail on its own merits (`OverconstrainedError`) and report itself as
 * a permission problem, which sends everyone looking in the wrong place.
 */
export async function requestAccess(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  closeStream(stream);
}

/**
 * The current microphone permission, where the browser will say.
 *
 * `PermissionStatus` also fires `change`, which is how the app notices
 * permission being revoked in site settings without a reload. Safari has no
 * `microphone` permission name and throws, hence 'unknown' — which the UI
 * treats as "offer the button", since asking twice is harmless and never
 * asking is not.
 */
export async function micPermission(): Promise<PermissionStatus | null> {
  try {
    return await navigator.permissions?.query({ name: 'microphone' as PermissionName });
  } catch {
    return null;
  }
}

/** Stop every track on a stream. Not stopping one holds the device open. */
export function closeStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const t of stream.getTracks()) t.stop();
}

/**
 * Open a device for capture.
 *
 * Pass `channels` from a previous probe when you have one; the default asks for
 * everything, which is what a probe is.
 */
export async function openDevice(deviceId: string | null, channels = PROBE_CHANNELS): Promise<OpenResult> {
  const stream = await navigator.mediaDevices.getUserMedia(captureConstraints(deviceId, channels));
  const track = stream.getAudioTracks()[0];
  if (!track) {
    closeStream(stream);
    throw new Error('the device opened but produced no audio track');
  }
  const { channels: got, sampleRate } = readTrack(track);
  return { stream, track, channels: got, sampleRate, ignored: describeProcessing(track) };
}

/**
 * List the audio inputs, with channel counts where they are already known.
 *
 * ## Nothing usable comes back before permission is granted
 *
 * Until the user has allowed microphone access at least once, a browser will
 * not describe the machine's audio hardware to a page. Chrome does not return
 * an empty list, which would be honest and obvious — it returns one entry per
 * kind with an **empty `deviceId` and an empty label**. That entry is a
 * placeholder saying "there is at least one input here", not a device that can
 * be opened: `getUserMedia({ deviceId: { exact: '' } })` matches nothing.
 *
 * Those placeholders are filtered out, so an empty result here means exactly
 * one thing — there is nothing selectable yet — and the caller's job is to ask
 * for permission with `requestAccess` and list again. Leaving them in produced
 * a genuine deadlock: they rendered as a pickable option whose value was the
 * empty string, which is also the value of the "choose a device" placeholder,
 * so choosing it was indistinguishable from choosing nothing and the code that
 * would have triggered the permission prompt never ran.
 */
export async function listDevices(known: Map<string, DeviceInfo> = new Map()): Promise<DeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput')
    // The synthetic "default"/"communications" entries are aliases for a real
    // device that is also in the list, and picking one means the OS can move
    // the recording to a different interface mid-take without telling anyone.
    .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
    // The pre-permission placeholder. See the note above — this is the filter
    // whose absence deadlocked the device picker.
    .filter((d) => d.deviceId !== '')
    .map((d) => {
      const prior = known.get(d.deviceId);
      return {
        deviceId: d.deviceId,
        label: d.label || 'Audio input (grant access to see its name)',
        channels: prior?.channels ?? 0,
        sampleRate: prior?.sampleRate ?? 0,
      };
    });
}

/**
 * Open a device, read what it is, and close it again.
 *
 * Used to populate the picker so the channel count is on screen before anything
 * is committed to. The stream is stopped before returning: holding a device
 * open shows a recording indicator, and on some interfaces locks the sample
 * rate against every other application on the machine.
 */
export async function probeDevice(deviceId: string): Promise<DeviceInfo> {
  const open = await openDevice(deviceId);
  closeStream(open.stream);
  const devices = await navigator.mediaDevices.enumerateDevices();
  const found = devices.find((d) => d.deviceId === deviceId);
  return {
    deviceId,
    label: found?.label || 'Audio input',
    channels: open.channels,
    sampleRate: open.sampleRate,
  };
}
