/**
 * Wiring. The engines own the audio; this owns the arrangement of the page and
 * the handful of decisions that need a person.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Setup } from './components/Setup';
import { Transport } from './components/Transport';
import { TrackList } from './components/TrackList';
import { MeterBridge } from './components/MeterBridge';
import { TakePanel } from './components/TakePanel';
import { isolationAvailable, recorder } from './lib/recorder';
import { player } from './lib/player';
import { listDevices, micPermission, requestAccess, type MicPermission } from './lib/devices';
import {
  canPickDirectory,
  ensurePermission,
  loadSavedDirectory,
  pickDirectory,
  type DirectoryHandle,
} from './lib/storage';
import { frameBytes } from './lib/wav';
import { bytesPerSecond } from './lib/format';
import { useStore } from './store';
import type { DeviceInfo, TakeManifest } from './types';

declare const __APP_VERSION__: string;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Subscribe to an engine's structural changes.
 *
 * The engines are plain classes outside React with a listener set, and they
 * change identity for nothing — so the snapshot is a counter rather than an
 * object. Returning the engine itself would have `useSyncExternalStore` compare
 * it by reference, find it unchanged, and never re-render.
 */
function useEngineVersion(subscribe: (fn: () => void) => () => void): number {
  // The counter lives in a ref, not a local. A local is reinitialised on every
  // render, so `getSnapshot` would return the same value for ever and the
  // component would subscribe to an engine it then never re-rendered for.
  const version = useRef(0);
  return useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        subscribe(() => {
          version.current++;
          onChange();
        }),
      [subscribe],
    ),
    () => version.current,
  );
}

export default function App() {
  const store = useStore();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [directory, setDirectory] = useState<DirectoryHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [masterGainDb, setMasterGainDb] = useState(0);
  const [permission, setPermission] = useState<MicPermission>('unknown');
  const [loadedTake, setLoadedTake] = useState<TakeManifest | null>(null);

  useEngineVersion(useCallback((fn: () => void) => recorder.subscribe(fn), []));
  useEngineVersion(useCallback((fn: () => void) => player.subscribe(fn), []));

  const isolated = isolationAvailable();
  const recording = recorder.status === 'recording';
  const armed = store.tracks.filter((t) => t.armed);

  // --- devices -------------------------------------------------------------

  const refresh = useCallback(async () => {
    setDevices(await listDevices(new Map(devices.map((d) => [d.deviceId, d]))));
  }, [devices]);

  useEffect(() => {
    if (!isolated) return;
    void listDevices().then(setDevices);
    // The list changes when an interface is plugged in or taken away, and a
    // recorder that needs a page reload to notice a device is a recorder that
    // gets blamed for the interface.
    const onChange = () => void listDevices().then(setDevices);
    navigator.mediaDevices?.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', onChange);
  }, [isolated]);

  useEffect(() => {
    void loadSavedDirectory().then(setDirectory);
  }, []);

  // Track the permission rather than assuming it. It can be granted in a
  // previous session and still be revoked in site settings later, and the
  // change event is how the picker empties itself instead of offering devices
  // that can no longer be opened.
  useEffect(() => {
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const onChange = () => {
      if (!status) return;
      setPermission(status.state as MicPermission);
      void listDevices().then(setDevices);
    };
    void micPermission().then((s) => {
      if (cancelled || !s) return;
      status = s;
      setPermission(s.state as MicPermission);
      s.addEventListener('change', onChange);
    });
    return () => {
      cancelled = true;
      status?.removeEventListener('change', onChange);
    };
  }, []);

  const grantAccess = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      await requestAccess();
      setPermission('granted');
      // Only now does enumerateDevices return real ids and labels.
      setDevices(await listDevices());
    } catch (err) {
      // Not every failure here is a refusal, and calling them all "denied"
      // sends someone to the padlock menu to fix a machine with nothing plugged
      // into it. The two cases need different sentences.
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setPermission('granted');
        setNotice('No audio input devices were found. Connect an interface and rescan.');
      } else if (name === 'NotAllowedError' || name === 'SecurityError') {
        setPermission('denied');
        setNotice(
          'Microphone access was refused, so the browser will not say what audio hardware exists. ' +
            'Allow it in the padlock menu in the address bar and try again.',
        );
      } else {
        setNotice(`The audio device could not be opened: ${describeError(err)}`);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const chooseDevice = useCallback(
    async (id: string) => {
      // An empty id is the "choose a device" placeholder, not a device. It used
      // to be reachable from a real entry too — see listDevices — and returning
      // silently here is what made that look like a dead dropdown.
      if (!id) return;
      setBusy(true);
      setNotice(null);
      try {
        await recorder.open(id, store.preRoll ? store.preRollSeconds : 0, store.monitorGainDb, store.monitor);
        if (recorder.status === 'monitoring') {
          store.set({ deviceId: id });
          store.setChannels(recorder.channels);
          // Labels are empty until permission has been granted once, so the
          // list is worth taking again now that it will have names in it.
          await refresh();
        }
      } finally {
        setBusy(false);
      }
    },
    [refresh, store],
  );

  // Re-open when the ring's shape changes. The ring is allocated at open, so a
  // different pre-roll length is a different buffer and there is no way to
  // resize it under a running graph.
  //
  // The monitor settings are read here but deliberately not depended on: they
  // are applied live by the effect below, and having them in this list would
  // tear the device down and back up on every drag of the monitor fader.
  const monitorRef = useRef({ on: store.monitor, db: store.monitorGainDb });
  useEffect(() => {
    monitorRef.current = { on: store.monitor, db: store.monitorGainDb };
  }, [store.monitor, store.monitorGainDb]);

  useEffect(() => {
    if (!store.deviceId || recorder.status !== 'monitoring') return;
    const wanted = store.preRoll ? store.preRollSeconds : 0;
    if (recorder.info.preRollFrames === Math.round(wanted * recorder.info.sampleRate)) return;
    void recorder.open(store.deviceId, wanted, monitorRef.current.db, monitorRef.current.on);
  }, [store.deviceId, store.preRoll, store.preRollSeconds]);

  useEffect(() => {
    recorder.setMonitor(store.monitor, store.monitorGainDb);
  }, [store.monitor, store.monitorGainDb]);

  // --- recording -----------------------------------------------------------

  const startRecording = useCallback(async () => {
    if (!directory) return;
    setNotice(null);
    // Must happen inside the click. A browser will not show a permission prompt
    // that is not attached to a gesture, and refuses it in a way that is
    // indistinguishable from the user saying no.
    if (!(await ensurePermission(directory))) {
      setNotice('Write access to that folder was not granted, so there is nowhere to record to.');
      return;
    }
    // Clip indicators latch, so a new take starts with them cleared. The meter
    // loop notices the generation has moved and drops the class it owns.
    recorder.clearClips();
    await recorder.record({
      directory,
      tracks: store.tracks,
      format: store.format,
      preRollFrames: store.preRoll ? Math.round(store.preRollSeconds * recorder.info.sampleRate) : 0,
      keepAwake: store.keepAwake,
    });
  }, [directory, store]);

  // A take in progress is unrecoverable if the tab goes. The browser will only
  // show its own generic wording, but it does show it.
  useEffect(() => {
    if (!recording) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [recording]);

  // --- playback ------------------------------------------------------------

  const loadTake = useCallback(
    async (take: TakeManifest) => {
      if (!directory) return;
      try {
        const folder = await directory.getDirectoryHandle(take.name, { create: false });
        await player.load(take, folder);
        setLoadedTake(take);
        player.setMix(store.tracks);
        player.setMasterGain(masterGainDb);
      } catch {
        setNotice(`The folder for ${take.name} could not be opened. Has it been moved?`);
      }
    },
    [directory, masterGainDb, store.tracks],
  );

  useEffect(() => {
    player.setMix(store.tracks);
  }, [store.tracks]);

  // --- render --------------------------------------------------------------

  if (!isolated) {
    return (
      <main className="app fatal">
        <h1>QuickDaw</h1>
        <p>
          This page is not cross-origin isolated, so it cannot allocate the shared buffer the
          recorder is built on.
        </p>
        <p className="hint">
          The deployed site sends the two headers that grant it, and so do <code>npm run dev</code>{' '}
          and <code>npm run preview</code>. A build served by anything else — or opened from a file
          path — will land here.
        </p>
      </main>
    );
  }

  const rate = recorder.info.sampleRate || 48000;
  const blockedReason = !store.deviceId
    ? 'Choose an interface first.'
    : !directory
      ? 'Choose a folder to record into.'
      : armed.length === 0
        ? 'Arm at least one track.'
        : recorder.status !== 'monitoring'
          ? 'Waiting for the device.'
          : null;

  return (
    <main className="app">
      <header>
        <h1>QuickDaw</h1>
        <p className="sub">
          Multitrack recorder. One track per input, straight to disk, with the last{' '}
          {store.preRollSeconds} seconds already in hand.
        </p>
      </header>

      {(recorder.lastError || notice) && (
        <p className="error" role="alert">
          {notice ?? recorder.lastError}
        </p>
      )}

      {/* Everything is connected and one click away from running. Saying so is
          the whole point: a silent meter bridge with no explanation is
          indistinguishable from a broken one. */}
      {recorder.needsGesture && (
        <p className="warn" role="status">
          The browser will not start audio until you interact with the page. Click anywhere to
          start the meters.
        </p>
      )}

      <Setup
        devices={devices}
        deviceId={store.deviceId}
        channels={recorder.channels}
        sampleRate={rate}
        ignored={recorder.info.ignored}
        directoryName={directory?.name ?? null}
        canPickDirectory={canPickDirectory()}
        busy={busy}
        recording={recording}
        permission={permission}
        onRequestAccess={() => void grantAccess()}
        preRoll={store.preRoll}
        preRollSeconds={store.preRollSeconds}
        format={store.format}
        monitor={store.monitor}
        monitorGainDb={store.monitorGainDb}
        keepAwake={store.keepAwake}
        onRefresh={() => void refresh()}
        onDevice={(id) => void chooseDevice(id)}
        onPickDirectory={() => void pickDirectory().then(setDirectory).catch(() => {})}
        onChange={(patch) => store.set(patch)}
      />

      {/* Above the transport on purpose: "is signal arriving?" is the question
          people ask immediately before pressing record, so the answer belongs
          between the setup and the button. */}
      <MeterBridge
        tracks={store.tracks}
        channels={recorder.channels}
        opening={busy || recorder.status === 'opening'}
      />

      <Transport
        status={recorder.status}
        armedCount={armed.length}
        bytesPerSecond={bytesPerSecond(armed.length, rate, frameBytes(store.format))}
        preRoll={store.preRoll}
        preRollSeconds={store.preRollSeconds}
        canRecord={blockedReason === null}
        blockedReason={blockedReason}
        onRecord={() => void startRecording()}
        onStop={() => void recorder.stop()}
      />

      <TrackList
        tracks={store.tracks}
        channels={recorder.channels}
        recording={recording}
        onChange={store.updateTrack}
        onClearSolo={store.clearSolo}
      />

      <TakePanel
        takes={recorder.takes}
        loaded={loadedTake}
        playing={player.status === 'playing'}
        masterGainDb={masterGainDb}
        onLoad={(t) => void loadTake(t)}
        onPlay={() => void player.play()}
        onPause={() => player.pause()}
        onSeek={(f) => player.seek(f)}
        onMasterGain={(db) => {
          setMasterGainDb(db);
          player.setMasterGain(db);
        }}
      />

      <footer className="version">{__APP_VERSION__}</footer>
    </main>
  );
}
