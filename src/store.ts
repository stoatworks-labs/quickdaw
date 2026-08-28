import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_SETTINGS, defaultTrack, type Settings, type Track } from './types';

interface QuickDawStore extends Settings {
  /** One per input on the interface, mapped 1:1 and in input order. */
  tracks: Track[];
  set: (patch: Partial<Settings>) => void;
  /**
   * Rebuild the track list for an interface with `channels` inputs.
   *
   * Names, arm state and mix settings are kept for any input that still exists,
   * so reconnecting the same interface — or reloading the page — does not throw
   * away the labelling. An interface with fewer inputs loses the extras; one
   * with more gains defaults.
   */
  setChannels: (channels: number) => void;
  updateTrack: (input: number, patch: Partial<Track>) => void;
  clearSolo: () => void;
  reset: () => void;
}

/**
 * Settings and the track list. Nothing that moves lives here.
 *
 * Meters, the playhead and the buffer readouts are read off the engines inside
 * `requestAnimationFrame`; only the handful of values a human changes are in
 * this store, so a re-render on change costs nothing and happens rarely.
 */
export const useStore = create<QuickDawStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      tracks: [],
      set: (patch) => set(patch),
      setChannels: (channels) =>
        set((s) => {
          const next: Track[] = [];
          for (let i = 0; i < channels; i++) {
            const prior = s.tracks.find((t) => t.input === i);
            next.push(prior ?? defaultTrack(i));
          }
          return { tracks: next };
        }),
      updateTrack: (input, patch) =>
        set((s) => ({
          tracks: s.tracks.map((t) => (t.input === input ? { ...t, ...patch } : t)),
        })),
      clearSolo: () => set((s) => ({ tracks: s.tracks.map((t) => ({ ...t, soloed: false })) })),
      reset: () => set({ ...DEFAULT_SETTINGS, tracks: [] }),
    }),
    {
      name: 'quickdaw.settings',
      version: 1,
      // Solo is a state you are in while listening to something, not a
      // preference. Coming back to a reloaded page with one track soloed and no
      // memory of having done it is a fault report waiting to happen.
      partialize: (s) => {
        const { set: _set, setChannels: _sc, updateTrack: _ut, clearSolo: _cs, reset: _r, ...rest } = s;
        return { ...rest, tracks: rest.tracks.map((t) => ({ ...t, soloed: false })) };
      },
    },
  ),
);
