import {
  exportCanvasFile,
  importCanvasFiles,
  listCanvases,
  setMirror,
  type CanvasFile,
} from "./storage";

/**
 * Minimal shapes for the File System Access API; not in the default TS lib.
 * Only the handful of members used here are declared.
 */
type Writable = {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
};

type FileHandle = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<Writable>;
};

type DirectoryHandle = {
  kind: "directory";
  name: string;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FileHandle>;
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>;
  values: () => AsyncIterableIterator<FileHandle | DirectoryHandle>;
  queryPermission: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>;
};

type DirectoryPicker = (options?: {
  mode?: "read" | "readwrite";
  id?: string;
}) => Promise<DirectoryHandle>;

/** Writes settle this long after the last edit; canvases can be megabytes. */
const WRITE_DEBOUNCE_MS = 1000;

const DB_NAME = "proto:folder";
const STORE = "handles";
const HANDLE_KEY = "directory";

export function isFolderSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

function picker(): DirectoryPicker | null {
  return (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker ?? null;
}

/* Handle persistence. Directory handles are structured-cloneable but not
   JSON-serializable, so they live in IndexedDB rather than localStorage. */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

function rememberHandle(handle: DirectoryHandle | null): Promise<unknown> {
  return handle
    ? withStore("readwrite", (s) => s.put(handle, HANDLE_KEY))
    : withStore("readwrite", (s) => s.delete(HANDLE_KEY));
}

function recallHandle(): Promise<DirectoryHandle | undefined> {
  return withStore<DirectoryHandle | undefined>("readonly", (s) => s.get(HANDLE_KEY));
}

/* Connection state. */

export type FolderStatus = {
  /** Null when no folder is connected. */
  name: string | null;
  /** A remembered folder whose permission needs a click to renew. */
  needsPermission: boolean;
  writing: boolean;
  error: string | null;
  savedAt: number | null;
  /** Files the last merge left alone, with the reason — never silently dropped. */
  skipped: string[];
};

let handle: DirectoryHandle | null = null;
let status: FolderStatus = {
  name: null,
  needsPermission: false,
  writing: false,
  error: null,
  savedAt: null,
  skipped: [],
};

const listeners = new Set<(status: FolderStatus) => void>();

export function getFolderStatus(): FolderStatus {
  return status;
}

export function subscribeToFolder(listener: (status: FolderStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(patch: Partial<FolderStatus>) {
  status = { ...status, ...patch };
  for (const listener of listeners) listener(status);
}

/* Writing. */

/** Long enough to recognise a canvas, short enough to keep filenames sane. */
const MAX_SLUG_LENGTH = 48;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
}

/**
 * `<name>-<id>.json`. The name is for reading the folder in git; the id is what
 * makes it unique and survives renames. A name with nothing sluggable in it
 * (only emoji, say) falls back to the bare id.
 */
function fileName(canvas: { id: string; name: string }): string {
  const slug = slugify(canvas.name);
  return slug ? `${slug}-${canvas.id}.json` : `${canvas.id}.json`;
}

const belongsTo = (entryName: string, canvasId: string) =>
  entryName === `${canvasId}.json` || entryName.endsWith(`-${canvasId}.json`);

/**
 * Drops every file for a canvas except `keep`. Since the name is part of the
 * filename, a rename writes to a new path and would otherwise leave the old one
 * behind; scanning by id also self-heals after a file is renamed outside the app.
 */
async function removeFilesFor(directory: DirectoryHandle, canvasId: string, keep?: string) {
  const stale: string[] = [];
  for await (const entry of directory.values()) {
    if (entry.kind === "file" && entry.name !== keep && belongsTo(entry.name, canvasId)) {
      stale.push(entry.name);
    }
  }
  for (const name of stale) {
    try {
      await directory.removeEntry(name);
    } catch (err) {
      // Gone already — nothing to clean up.
      if (!(err instanceof DOMException && err.name === "NotFoundError")) throw err;
    }
  }
}

/** One file per canvas, pretty-printed so git diffs stay line-based and readable. */
function serialize(file: CanvasFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

// Every write goes through one chain: two writables open on the same file at
// once corrupt it, and the debounce alone does not prevent overlap.
let chain: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  chain = chain.then(task).catch((err) => {
    update({
      writing: false,
      error: err instanceof Error ? err.message : "could not write to the folder",
    });
  });
  return chain;
}

async function writeFile(directory: DirectoryHandle, file: CanvasFile) {
  const name = fileName(file);
  const target = await directory.getFileHandle(name, { create: true });
  const writable = await target.createWritable();
  await writable.write(serialize(file));
  await writable.close();
  await removeFilesFor(directory, file.id, name);
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleWrite(canvasId: string) {
  const existing = timers.get(canvasId);
  if (existing) clearTimeout(existing);
  timers.set(
    canvasId,
    setTimeout(() => {
      timers.delete(canvasId);
      const file = exportCanvasFile(canvasId);
      if (!handle || !file) return;
      const directory = handle;
      update({ writing: true, error: null });
      enqueue(async () => {
        await writeFile(directory, file);
        update({ writing: false, savedAt: Date.now() });
      });
    }, WRITE_DEBOUNCE_MS)
  );
}

function scheduleRemove(canvasId: string) {
  const existing = timers.get(canvasId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(canvasId);
  }
  if (!handle) return;
  const directory = handle;
  // The canvas is already out of localStorage by now, so its name is gone with
  // it — the file has to be found by id.
  enqueue(() => removeFilesFor(directory, canvasId));
}

function connect(directory: DirectoryHandle) {
  handle = directory;
  setMirror({ write: scheduleWrite, remove: scheduleRemove });
  update({ name: directory.name, needsPermission: false, error: null });
}

/**
 * Reconciles the folder and this browser in both directions: the union of both
 * sides, and for a canvas on both, whichever was edited last. Neither side is
 * clobbered, so connecting a folder at a second machine merges rather than
 * replaces.
 *
 * The deliberate trade-off is that a canvas deleted on one machine comes back
 * if another browser still holds a copy. Resurrecting a canvas is a smaller
 * problem than silently dropping one.
 */
async function merge(directory: DirectoryHandle): Promise<number> {
  const { entries, skipped } = await readAll(directory);
  update({ skipped });

  // Several files can carry the same canvas id — a rename on another machine,
  // a git merge that kept both sides. Directory iteration order is arbitrary,
  // so the newest edit wins explicitly rather than whichever is read last.
  const byId = new Map<string, CanvasFile>();
  const fileNameOf = new Map<string, string>();
  const duplicated = new Set<string>();
  for (const { file, name } of entries) {
    const existing = byId.get(file.id);
    if (!existing) {
      byId.set(file.id, file);
      fileNameOf.set(file.id, name);
      continue;
    }
    duplicated.add(file.id);
    if (file.updatedAt > existing.updatedAt) {
      byId.set(file.id, file);
      fileNameOf.set(file.id, name);
    }
  }

  const contribute: CanvasFile[] = [];
  for (const meta of listCanvases()) {
    const local = exportCanvasFile(meta.id);
    if (!local) continue;
    const remote = byId.get(local.id);
    if (remote && remote.updatedAt >= local.updatedAt) continue;
    byId.set(local.id, local);
    contribute.push(local);
  }

  importCanvasFiles([...byId.values()]);

  // Stale duplicates of a locally-newer canvas are already removed by
  // writeFile's cleanup; the rest are pruned here so they stop shadowing.
  const contributed = new Set(contribute.map((file) => file.id));
  const heals = [...duplicated].filter((id) => !contributed.has(id));

  if (contribute.length || heals.length) {
    update({ writing: true, error: null });
    await enqueue(async () => {
      for (const file of contribute) await writeFile(directory, file);
      for (const id of heals) await removeFilesFor(directory, id, fileNameOf.get(id));
      update({ writing: false, savedAt: Date.now() });
    });
  }
  return byId.size;
}

type ReadResult = {
  entries: { file: CanvasFile; name: string }[];
  skipped: string[];
};

async function readAll(directory: DirectoryHandle): Promise<ReadResult> {
  const entries: { file: CanvasFile; name: string }[] = [];
  const skipped: string[] = [];
  for await (const entry of directory.values()) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
    const text = await (await entry.getFile()).text();
    let parsed: CanvasFile;
    try {
      parsed = JSON.parse(text) as CanvasFile;
    } catch {
      // Hand-edited or half-written — often git conflict markers.
      skipped.push(`${entry.name} (unreadable — merge conflict?)`);
      continue;
    }
    if (!parsed?.id || !Array.isArray(parsed.nodes)) {
      skipped.push(`${entry.name} (not a canvas file)`);
      continue;
    }
    // A file whose name doesn't carry its canvas id — a "download json" copy
    // dropped into the folder, say — would shadow the real file for that
    // canvas on every merge, and the cleanup that prunes stale files could
    // never match it. Leave it alone, but say so.
    if (!belongsTo(entry.name, parsed.id)) {
      skipped.push(`${entry.name} (filename doesn't match its canvas id)`);
      continue;
    }
    entries.push({ file: parsed, name: entry.name });
  }
  return { entries, skipped };
}

/* Public actions. Each picker call must happen in a user gesture. */

/**
 * Picks a folder and merges it with this browser. Returns the canvas count
 * afterwards. Works both for a folder that is empty and for one already full of
 * canvases from another machine.
 */
export async function connectFolder(): Promise<number> {
  const pick = picker();
  if (!pick) throw new Error("this browser cannot open folders");
  const directory = await pick({ mode: "readwrite", id: "proto-canvases" });
  await rememberHandle(directory);
  connect(directory);
  return merge(directory);
}

/** Stops mirroring. Canvases stay in this browser and in the folder. */
export async function disconnectFolder(): Promise<void> {
  handle = null;
  setMirror(null);
  await rememberHandle(null);
  update({ name: null, needsPermission: false, error: null, savedAt: null, skipped: [] });
}

/**
 * Reconnects the remembered folder on startup and reconciles it, picking up
 * anything pulled in from another machine since the last visit. Returns true if
 * a folder is connected afterwards.
 *
 * Runs once per session no matter how many pages ask — the home list and the
 * root layout both call it on mount, and a second merge would be wasted work.
 */
let restorePromise: Promise<boolean> | null = null;

export function restoreFolder(): Promise<boolean> {
  if (!restorePromise) restorePromise = restoreFolderOnce();
  return restorePromise;
}

async function restoreFolderOnce(): Promise<boolean> {
  if (!isFolderSupported()) return false;

  let remembered: DirectoryHandle | undefined;
  try {
    remembered = await recallHandle();
  } catch {
    return false;
  }
  if (!remembered) return false;

  // Chrome may or may not carry the grant across sessions; when it does not,
  // renewing it needs a click, so surface that instead of pulling silently.
  if ((await remembered.queryPermission({ mode: "readwrite" })) !== "granted") {
    handle = null;
    update({ name: remembered.name, needsPermission: true });
    return false;
  }

  connect(remembered);
  await merge(remembered);
  return true;
}

/** Renews permission on the remembered folder. Must run in a user gesture. */
export async function renewFolderPermission(): Promise<boolean> {
  const remembered = await recallHandle();
  if (!remembered) return false;
  if ((await remembered.requestPermission({ mode: "readwrite" })) !== "granted") return false;

  connect(remembered);
  await merge(remembered);
  return true;
}
