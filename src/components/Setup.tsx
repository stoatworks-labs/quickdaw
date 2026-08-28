/**
 * Choosing an interface, a folder, and how the take is written.
 *
 * Everything here is set before a take and fixed during one. That is a
 * deliberate limit rather than an omission: changing the sample format, the
 * pre-roll length or the device mid-recording all mean re-opening files that
 * are already being written, and a recorder that can be reconfigured while it
 * runs is a recorder that can be broken while it runs.
 */

import { PREROLL_SECONDS, WRITE_HEADROOM_SECONDS, type PreRollSeconds, type SampleFormat } from '../types';
import { SAMPLE_FORMATS, frameBytes } from '../lib/wav';
import { formatBytes } from '../lib/format';
import type { DeviceInfo } from '../types';
import type { MicPermission } from '../lib/devices';

interface Props {
  devices: DeviceInfo[];
  deviceId: string | null;
  channels: number;
  sampleRate: number;
  ignored: string[];
  directoryName: string | null;
  canPickDirectory: boolean;
  busy: boolean;
  recording: boolean;
  permission: MicPermission;
  onRequestAccess: () => void;
  preRoll: boolean;
  preRollSeconds: PreRollSeconds;
  format: SampleFormat;
  monitor: boolean;
  monitorGainDb: number;
  keepAwake: boolean;
  onRefresh: () => void;
  onDevice: (id: string) => void;
  onPickDirectory: () => void;
  onChange: (patch: {
    preRoll?: boolean;
    preRollSeconds?: PreRollSeconds;
    format?: SampleFormat;
    monitor?: boolean;
    monitorGainDb?: number;
    keepAwake?: boolean;
  }) => void;
}

/**
 * Resident memory the pre-roll costs on this interface.
 *
 * Shown as a figure rather than left to be found out. Sixty seconds of a
 * 32-input interface at 96 kHz is 737 MB of memory that is allocated for as
 * long as the device is open, and a browser tab that is asked for it and cannot
 * have it fails at the moment the device opens rather than sympathetically.
 */
function ringMemory(channels: number, sampleRate: number, preRollSeconds: number, preRoll: boolean): number {
  const seconds = (preRoll ? preRollSeconds : 0) + WRITE_HEADROOM_SECONDS;
  return channels * sampleRate * 4 * seconds;
}

export function Setup(props: Props) {
  const {
    devices,
    deviceId,
    channels,
    sampleRate,
    ignored,
    directoryName,
    canPickDirectory,
    busy,
    recording,
    permission,
    onRequestAccess,
    preRoll,
    preRollSeconds,
    format,
    monitor,
    monitorGainDb,
    keepAwake,
    onRefresh,
    onDevice,
    onPickDirectory,
    onChange,
  } = props;

  const bytesPerFrame = frameBytes(format);
  const memory = channels ? ringMemory(channels, sampleRate, preRollSeconds, preRoll) : 0;

  return (
    <section className="setup" aria-label="Setup">
      <div className="field">
        <label htmlFor="device">Interface</label>

        {/* A browser will not name — or even identify — the machine's audio
            hardware until microphone access has been granted once. Before that
            there is nothing to put in a dropdown, so the dropdown is not the
            control: this button is. Showing an empty picker instead is how this
            deadlocked, because the one thing that triggers the prompt is asking
            for a stream, and nothing was ever able to ask. */}
        {devices.length === 0 ? (
          permission === 'denied' ? (
            <p className="warn">
              Microphone access is blocked for this site, so the browser will not say what audio
              hardware exists. Allow it in the padlock menu in the address bar, then Rescan.
            </p>
          ) : permission === 'granted' ? (
            <div className="row">
              <p className="hint">No audio inputs found. Connect an interface and rescan.</p>
              <button type="button" onClick={onRefresh} disabled={busy}>
                Rescan
              </button>
            </div>
          ) : (
            <div className="row">
              <button type="button" className="primary" onClick={onRequestAccess} disabled={busy}>
                {busy ? 'Waiting…' : 'Allow microphone access'}
              </button>
              <p className="hint">
                Needed to list your interfaces — nothing is recorded until you press record, and no
                audio leaves this machine.
              </p>
            </div>
          )
        ) : (
          <div className="row">
            <select
              id="device"
              value={deviceId ?? ''}
              disabled={recording || busy}
              onChange={(e) => onDevice(e.target.value)}
            >
              <option value="">Choose an audio input…</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                  {d.channels ? ` — ${d.channels} in` : ''}
                </option>
              ))}
            </select>
            <button type="button" onClick={onRefresh} disabled={recording || busy}>
              Rescan
            </button>
          </div>
        )}
        {channels > 0 && (
          <p className="hint">
            {channels} input{channels === 1 ? '' : 's'} at {sampleRate.toLocaleString()} Hz — one
            track each, mapped 1:1.
          </p>
        )}
        {ignored.length > 0 && (
          // A constraint the browser accepted and then did not apply looks
          // exactly like one it honoured. If it is processing the signal, the
          // recording is of the processing, and that has to be said out loud.
          <p className="warn">
            The browser is still applying {ignored.join(', ')} to this device. What is recorded is
            its processing, not the interface.
          </p>
        )}
      </div>

      <div className="field">
        <label>Record to</label>
        <div className="row">
          <button type="button" onClick={onPickDirectory} disabled={recording || !canPickDirectory}>
            {directoryName ? 'Change folder…' : 'Choose a folder…'}
          </button>
          <span className="path">{directoryName ?? 'nothing chosen'}</span>
        </div>
        {!canPickDirectory && (
          <p className="warn">
            This browser has no File System Access API, so takes cannot be streamed to a folder you
            choose. Chrome or Edge can.
          </p>
        )}
        <p className="hint">
          Files are staged by the browser and appear in the folder when the take stops. A tab that
          is killed part-way through leaves nothing behind.
        </p>
      </div>

      <div className="field">
        <label htmlFor="preroll">Pre-roll buffer</label>
        <div className="row">
          <input
            id="preroll"
            type="checkbox"
            checked={preRoll}
            disabled={recording}
            onChange={(e) => onChange({ preRoll: e.target.checked })}
          />
          <select
            value={preRollSeconds}
            disabled={recording || !preRoll}
            aria-label="Pre-roll length"
            onChange={(e) => onChange({ preRollSeconds: Number(e.target.value) as PreRollSeconds })}
          >
            {PREROLL_SECONDS.map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
          </select>
        </div>
        <p className="hint">
          {preRoll
            ? `Every input is being held continuously. Pressing record puts the previous ` +
              `${preRollSeconds} seconds at the head of the take.`
            : 'The take starts at the moment you press record.'}
          {memory > 0 && ` Buffer: ${formatBytes(memory)} of memory.`}
        </p>
      </div>

      <div className="field">
        <label htmlFor="format">Format</label>
        <select
          id="format"
          value={format}
          disabled={recording}
          onChange={(e) => onChange({ format: e.target.value as SampleFormat })}
        >
          {(Object.keys(SAMPLE_FORMATS) as SampleFormat[]).map((f) => (
            <option key={f} value={f}>
              {SAMPLE_FORMATS[f].label}
            </option>
          ))}
        </select>
        <p className="hint">
          {SAMPLE_FORMATS[format].hint} {formatBytes(bytesPerFrame * sampleRate)} per track per
          second.
        </p>
      </div>

      <div className="field">
        <label htmlFor="monitor">Monitor</label>
        <div className="row">
          <input
            id="monitor"
            type="checkbox"
            checked={monitor}
            onChange={(e) => onChange({ monitor: e.target.checked })}
          />
          <input
            type="range"
            min={-40}
            max={0}
            step={1}
            value={monitorGainDb}
            disabled={!monitor}
            aria-label="Monitor level"
            onChange={(e) => onChange({ monitorGainDb: Number(e.target.value) })}
          />
          <span className="path">{monitorGainDb} dB</span>
        </div>
        <p className="warn small">
          Off by default. This sends every input to the default output, and on an open microphone
          that is a feedback loop. Use headphones.
        </p>
      </div>

      <div className="field">
        <label htmlFor="awake">Keep awake</label>
        <input
          id="awake"
          type="checkbox"
          checked={keepAwake}
          onChange={(e) => onChange({ keepAwake: e.target.checked })}
        />
        <p className="hint">
          Holds a wake lock for the length of a take. A machine that sleeps mid-recording stops the
          audio device.
        </p>
      </div>
    </section>
  );
}
