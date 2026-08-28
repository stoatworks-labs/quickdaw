/**
 * Where takes are written.
 *
 * Two targets, in order of preference:
 *
 * 1. **A folder you choose.** `showDirectoryPicker` returns a handle the app can
 *    stream into, so a take goes straight to the disk you meant it to go to and
 *    is already where a DAW can open it. Chrome and Edge only — the File System
 *    Access API exists nowhere else.
 * 2. **The origin private file system.** Everywhere, including Firefox and
 *    Safari, but it is storage the browser owns: the take has to be exported
 *    afterwards to become a file you can point anything at, and clearing site
 *    data destroys it.
 *
 * The chosen handle is kept in IndexedDB, because a `FileSystemDirectoryHandle`
 * survives structured cloning and a reload should not mean picking the folder
 * again. The *permission* does not survive with it — the browser re-asks on the
 * first write after a reload, which `ensurePermission` is for.
 *
 * ## The caveat worth knowing before a take, not after
 *
 * A `FileSystemWritableFileStream` does not write in place. Chrome stages the
 * data in a swap file and moves it into position at `close()`. For a recorder
 * that means the take is on disk the whole time but is not *visible* as the
 * file until it is stopped, and a tab that is killed mid-take leaves nothing
 * behind. It is the price of the single-pass write that keeps the throughput
 * up, and the UI says so rather than letting it be a surprise.
 */

const DB_NAME = 'quickdaw';
const STORE = 'handles';
const KEY = 'take-directory';

export type DirectoryHandle = FileSystemDirectoryHandle;

/** Whether this browser can stream a take into a folder the user picks. */
export function canPickDirectory(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

export async function loadSavedDirectory(): Promise<DirectoryHandle | null> {
  try {
    return (await idb<DirectoryHandle | undefined>('readonly', (s) => s.get(KEY))) ?? null;
  } catch {
    // A browser with IndexedDB disabled, or private-mode quirks. Not being able
    // to remember the folder is a small loss; it is not worth an error path.
    return null;
  }
}

export async function saveDirectory(handle: DirectoryHandle): Promise<void> {
  try {
    await idb('readwrite', (s) => s.put(handle, KEY));
  } catch {
    /* see loadSavedDirectory */
  }
}

export async function forgetDirectory(): Promise<void> {
  try {
    await idb('readwrite', (s) => s.delete(KEY));
  } catch {
    /* see loadSavedDirectory */
  }
}

export async function pickDirectory(): Promise<DirectoryHandle> {
  const pick = (
    globalThis as unknown as {
      showDirectoryPicker: (o: { mode: 'readwrite'; id?: string }) => Promise<DirectoryHandle>;
    }
  ).showDirectoryPicker;
  const handle = await pick({ mode: 'readwrite', id: 'quickdaw-takes' });
  await saveDirectory(handle);
  return handle;
}

type Permissioned = FileSystemHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
};

/**
 * Re-acquire write permission on a remembered folder.
 *
 * Must be called from a user gesture when it has to prompt — a browser refuses
 * the request otherwise, and the refusal is indistinguishable from a denial.
 * That is why the app asks on the button press that starts a take rather than
 * quietly at load.
 */
export async function ensurePermission(handle: DirectoryHandle): Promise<boolean> {
  const h = handle as Permissioned;
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  if (!h.requestPermission) return false;
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

/** The origin private file system's root. Available in every modern browser. */
export function opfsRoot(): Promise<DirectoryHandle> {
  return navigator.storage.getDirectory();
}

/**
 * A name that is safe on every filesystem a browser will be asked to write to.
 *
 * Windows is the strict one, so its rules are applied everywhere: it rejects
 * the nine reserved punctuation characters and every control character, rejects
 * a trailing dot or space, and reserves a list of legacy device names outright
 * — a track called `CON` is not creatable there even with an extension. Folding
 * to that rule means a take recorded on a Mac still opens on a PC.
 *
 * Spaces are deliberately kept. They are legal on every platform, the take
 * folders have them, and turning `Room L` into `Room-L` would be this function
 * quietly renaming something a person typed.
 *
 * Control characters are removed by comparing code points rather than by a
 * range inside the character class. That is not stylistic: this class carried a
 * *literal* NUL and a literal 0x1f during development, which is indistinguishable
 * from anything else in an editor, matched something entirely different from
 * what the code around it claimed, and was invisible to review. A comparison
 * cannot be wrong in a way that does not show. `naming.test.ts` is what caught
 * it the first time.
 */
export function safeName(name: string, fallback: string): string {
  let out = '';
  for (const ch of name.replace(RESERVED, '-')) {
    out += ch.codePointAt(0)! < 0x20 ? '-' : ch;
  }
  out = out.replace(/[. ]+$/, '').trim().slice(0, 64);
  if (RESERVED_DEVICE.test(out)) out = `_${out}`;
  return out || fallback;
}

/** The nine characters Windows rejects in a filename. */
const RESERVED = /[<>:"/\\|?*]/g;

/** Legacy DOS device names. Not creatable on Windows, with or without a suffix. */
const RESERVED_DEVICE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** `QuickDaw 2026-08-28 14-32-05` — sortable, and legal everywhere. */
export function takeFolderName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `QuickDaw ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ` +
    `${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`
  );
}

/** `01 Kick.wav`. The index keeps a DAW's import order matching the interface. */
export function trackFileName(input: number, name: string): string {
  return `${String(input + 1).padStart(2, '0')} ${safeName(name, `Input ${input + 1}`)}.wav`;
}
