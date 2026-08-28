/**
 * What comes back from `enumerateDevices`, and what must not.
 *
 * This file exists because of a real deadlock. Before microphone access is
 * granted, Chrome does not return an empty device list — it returns a
 * placeholder entry with an **empty deviceId**. That entry rendered as a
 * pickable option whose value was the empty string, which is also the value of
 * the "choose a device" placeholder, so selecting it was indistinguishable from
 * selecting nothing. The handler returned early, `getUserMedia` was never
 * called, the permission prompt never appeared, and the device list could
 * therefore never be populated. The app looked broken and offered no way out.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureConstraints,
  describeProcessing,
  listDevices,
  realDevices,
  TEST_DEVICE_ID,
} from '../devices';
import { TEST_CHANNELS } from '../testsignal';
import type { DeviceInfo } from '../../types';

function stubDevices(devices: Partial<MediaDeviceInfo>[]) {
  vi.stubGlobal('navigator', {
    mediaDevices: { enumerateDevices: () => Promise.resolve(devices as MediaDeviceInfo[]) },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('listDevices', () => {
  it('drops the empty-id placeholder returned before permission is granted', async () => {
    // Exactly what Chrome returns with no permission: one entry per kind, no id
    // and no label. It is a statement that hardware exists, not a device.
    stubDevices([{ kind: 'audioinput', deviceId: '', label: '' }]);
    expect(realDevices(await listDevices())).toEqual([]);
  });

  it('drops "default" and "communications", which are aliases', async () => {
    // Picking one lets the OS move the recording to a different interface
    // mid-take without telling anyone.
    stubDevices([
      { kind: 'audioinput', deviceId: 'default', label: 'Default' },
      { kind: 'audioinput', deviceId: 'communications', label: 'Communications' },
      { kind: 'audioinput', deviceId: 'abc123', label: 'Scarlett 18i20' },
    ]);
    const got = realDevices(await listDevices());
    expect(got.map((d) => d.deviceId)).toEqual(['abc123']);
  });

  it('ignores outputs entirely', async () => {
    stubDevices([
      { kind: 'audiooutput', deviceId: 'out1', label: 'Speakers' },
      { kind: 'videoinput', deviceId: 'cam1', label: 'Webcam' },
      { kind: 'audioinput', deviceId: 'in1', label: 'Mic' },
    ]);
    expect(realDevices(await listDevices()).map((d) => d.deviceId)).toEqual(['in1']);
  });

  it('carries a previous probe forward so the channel count survives a rescan', async () => {
    stubDevices([{ kind: 'audioinput', deviceId: 'abc123', label: 'Scarlett 18i20' }]);
    const known = new Map<string, DeviceInfo>([
      ['abc123', { deviceId: 'abc123', label: 'Scarlett 18i20', channels: 18, sampleRate: 48000 }],
    ]);
    const [d] = realDevices(await listDevices(known));
    expect(d.channels).toBe(18);
    expect(d.sampleRate).toBe(48000);
  });

  it('says why a name is missing rather than showing a blank row', async () => {
    stubDevices([{ kind: 'audioinput', deviceId: 'abc123', label: '' }]);
    const [d] = realDevices(await listDevices());
    expect(d.label).toMatch(/grant access/i);
  });

  it('always offers the generated source, last, whatever the hardware says', () => {
    // The app must never be a dead end. With no interface, no permission, or a
    // refused prompt, there is still something to record — and it is last in
    // the list so it is never reached for by accident.
    return (async () => {
      stubDevices([]);
      const empty = await listDevices();
      expect(empty).toHaveLength(1);
      expect(empty[0].deviceId).toBe(TEST_DEVICE_ID);
      expect(empty[0].channels).toBe(TEST_CHANNELS);

      stubDevices([{ kind: 'audioinput', deviceId: 'abc123', label: 'Scarlett' }]);
      const withHardware = await listDevices();
      expect(withHardware.map((d) => d.deviceId)).toEqual(['abc123', TEST_DEVICE_ID]);
    })();
  });
});

describe('captureConstraints', () => {
  it('switches off all three processors the browser turns on by default', () => {
    // Automatic gain in particular will ride a take's level up and down for its
    // whole length. Leave any of these on and the recording is of the browser's
    // voice pipeline rather than of the interface.
    const audio = captureConstraints('abc', 8).audio as MediaTrackConstraints;
    expect(audio.echoCancellation).toBe(false);
    expect(audio.noiseSuppression).toBe(false);
    expect(audio.autoGainControl).toBe(false);
  });

  it('asks for the channel count as ideal, never exact', () => {
    // `exact` above what the device has is an OverconstrainedError and no
    // stream at all; `ideal` gets whatever it can give and lets us read it back.
    const audio = captureConstraints('abc', 64).audio as MediaTrackConstraints;
    expect(audio.channelCount).toEqual({ ideal: 64 });
    expect(audio.deviceId).toEqual({ exact: 'abc' });
  });

  it('never requests video', () => {
    expect(captureConstraints(null, 2).video).toBe(false);
  });
});

describe('describeProcessing', () => {
  const track = (settings: Record<string, unknown>) =>
    ({ getSettings: () => settings }) as unknown as MediaStreamTrack;

  it('reports nothing when the browser honoured the constraints', () => {
    expect(
      describeProcessing(
        track({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }),
      ),
    ).toEqual([]);
  });

  it('names anything the browser accepted and then applied anyway', () => {
    // A constraint accepted and then ignored looks exactly like one that was
    // honoured. If it is processing the signal, the recording is of the
    // processing, and the app has to say so.
    expect(describeProcessing(track({ autoGainControl: true }))).toEqual(['automatic gain']);
    expect(
      describeProcessing(track({ echoCancellation: true, noiseSuppression: true })),
    ).toEqual(['echo cancellation', 'noise suppression']);
  });
});
