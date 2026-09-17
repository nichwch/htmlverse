import { forkNodes, migrateMessageReferences } from "./mentions";
import {
  API_KEY_STORAGE_KEY,
  EXPORT_LAYOUT_STORAGE_KEY,
  INSTRUCTIONS_STORAGE_KEY,
  type CanvasMeta,
  type ExportLayout,
  type StoredNode,
} from "./types";

const INDEX_KEY = "proto:canvases";
const LEGACY_NODES_KEY = "proto:canvas";

const nodesKey = (canvasId: string) => `proto:canvas:${canvasId}:nodes`;
const instructionsKey = (canvasId: string) => `proto:canvas:${canvasId}:instructions`;

/** A whole canvas in one object — what a folder-backed browser writes per file. */
export type CanvasFile = CanvasMeta & {
  instructions: string;
  nodes: StoredNode[];
};

/**
 * Optional write-through to a local folder. Registered by `lib/folder.ts` when
 * one is connected; localStorage stays the synchronous store either way.
 *
 * Only canvases pass through here. The openrouter api key lives under the same
 * `proto:` prefix and must never be mirrored, which is why this takes canvas
 * ids rather than storage keys.
 */
export type Mirror = {
  write: (canvasId: string) => void;
  remove: (canvasId: string) => void;
};

let mirror: Mirror | null = null;

export function setMirror(next: Mirror | null) {
  mirror = next;
}

function read<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Never turn an unreadable save into an empty canvas that autosave overwrites.
    throw new Error("Saved canvas data could not be read. The existing browser copy has been left untouched.");
  }
}

/** Apply a group of storage writes without leaving a partial import on quota failure. */
function writeBatch(entries: [string, string][]) {
  const before = new Map(entries.map(([key]) => [key, localStorage.getItem(key)]));
  const written: string[] = [];
  try {
    for (const [key, value] of entries) {
      localStorage.setItem(key, value);
      written.push(key);
    }
  } catch (error) {
    // Release the replacement data first, so restoring previous values fits.
    for (const key of written) localStorage.removeItem(key);
    for (const key of written) {
      const value = before.get(key);
      if (value !== null && value !== undefined) localStorage.setItem(key, value);
    }
    throw error;
  }
}

/** One-time move of the single pre-multi-canvas board into the canvas index. */
function migrateLegacyCanvas() {
  const legacy = localStorage.getItem(LEGACY_NODES_KEY);
  if (legacy === null) return;

  const now = Date.now();
  const meta: CanvasMeta = { id: crypto.randomUUID(), name: "untitled", createdAt: now, updatedAt: now };
  localStorage.setItem(nodesKey(meta.id), legacy);
  localStorage.setItem(INDEX_KEY, JSON.stringify([meta, ...read<CanvasMeta[]>(INDEX_KEY, [])]));
  localStorage.removeItem(LEGACY_NODES_KEY);
}

/** Instructions used to be one global setting; hand them to every canvas that existed then. */
function migrateGlobalInstructions(canvases: CanvasMeta[]) {
  const legacy = localStorage.getItem(INSTRUCTIONS_STORAGE_KEY);
  if (legacy === null) return;
  for (const canvas of canvases) {
    if (localStorage.getItem(instructionsKey(canvas.id)) === null) {
      localStorage.setItem(instructionsKey(canvas.id), legacy);
    }
  }
  localStorage.removeItem(INSTRUCTIONS_STORAGE_KEY);
}

export function listCanvases(): CanvasMeta[] {
  migrateLegacyCanvas();
  const canvases = read<CanvasMeta[]>(INDEX_KEY, []);
  migrateGlobalInstructions(canvases);
  return canvases.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getCanvas(id: string): CanvasMeta | null {
  return listCanvases().find((c) => c.id === id) ?? null;
}

function writeIndex(canvases: CanvasMeta[]) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(canvases));
}

export function createCanvas(name = "untitled"): CanvasMeta {
  const now = Date.now();
  const meta: CanvasMeta = { id: crypto.randomUUID(), name, createdAt: now, updatedAt: now };
  writeIndex([meta, ...listCanvases()]);
  mirror?.write(meta.id);
  return meta;
}

export function renameCanvas(id: string, name: string) {
  writeIndex(listCanvases().map((c) => (c.id === id ? { ...c, name } : c)));
  mirror?.write(id);
}

export function deleteCanvas(id: string) {
  localStorage.removeItem(nodesKey(id));
  localStorage.removeItem(instructionsKey(id));
  writeIndex(listCanvases().filter((c) => c.id !== id));
  mirror?.remove(id);
}

/** Copies a canvas and every node on it, under fresh ids. */
export function forkCanvas(id: string): CanvasMeta | null {
  const source = getCanvas(id);
  if (!source) return null;

  const now = Date.now();
  const meta: CanvasMeta = {
    id: crypto.randomUUID(),
    name: `${source.name} (fork)`,
    createdAt: now,
    updatedAt: now,
  };
  const nodes = forkNodes(loadNodes(id));
  localStorage.setItem(nodesKey(meta.id), JSON.stringify(nodes));
  localStorage.setItem(instructionsKey(meta.id), getInstructions(id));
  writeIndex([meta, ...listCanvases()]);
  mirror?.write(meta.id);
  return meta;
}

export function loadNodes(canvasId: string): StoredNode[] {
  return migrateMessageReferences(read<StoredNode[]>(nodesKey(canvasId), []));
}

export class CanvasConflictError extends Error {}

/** Exact persisted snapshot used to reject stale editor writes after a folder merge. */
export function savedNodesSnapshot(canvasId: string): string | null {
  return localStorage.getItem(nodesKey(canvasId));
}

export function saveNodes(canvasId: string, nodes: StoredNode[], expected?: string | null) {
  if (expected !== undefined && savedNodesSnapshot(canvasId) !== expected) {
    throw new CanvasConflictError("This canvas changed in another tab or during folder sync. Your edits have not overwritten it. Back up your edits before reloading.");
  }
  writeBatch([
    [nodesKey(canvasId), JSON.stringify(nodes)],
    [INDEX_KEY, JSON.stringify(listCanvases().map((c) => (c.id === canvasId ? { ...c, updatedAt: Date.now() } : c)))],
  ]);
  mirror?.write(canvasId);
}

/** The whole canvas as one object, or null if it is not in this browser. */
export function exportCanvasFile(canvasId: string): CanvasFile | null {
  const meta = getCanvas(canvasId);
  if (!meta) return null;
  return { ...meta, instructions: getInstructions(canvasId), nodes: loadNodes(canvasId) };
}

/** Merge folder snapshots without first deleting the browser's saved work. */
export function importCanvasFiles(files: CanvasFile[]) {
  const index = new Map(listCanvases().map((meta) => [meta.id, meta]));
  const entries: [string, string][] = [];
  for (const file of files) {
    if (!file.id || !Array.isArray(file.nodes) || !Number.isFinite(file.updatedAt)) {
      throw new Error("A folder canvas is invalid. Browser saves have been left untouched.");
    }
    const local = index.get(file.id);
    // A save may have completed while the folder was being read.
    if (local && local.updatedAt >= file.updatedAt && localStorage.getItem(nodesKey(file.id)) !== null) continue;
    entries.push([nodesKey(file.id), JSON.stringify(file.nodes)], [instructionsKey(file.id), file.instructions ?? ""]);
    index.set(file.id, { id: file.id, name: file.name, createdAt: file.createdAt, updatedAt: file.updatedAt });
  }
  entries.push([INDEX_KEY, JSON.stringify([...index.values()])]);
  writeBatch(entries);
}

/* Settings. The api key and export layout are global; instructions are per canvas. */

export function getApiKey(): string {
  return localStorage.getItem(API_KEY_STORAGE_KEY) ?? "";
}

export function setApiKey(key: string) {
  localStorage.setItem(API_KEY_STORAGE_KEY, key);
}

export function getInstructions(canvasId: string): string {
  return localStorage.getItem(instructionsKey(canvasId)) ?? "";
}

export function setInstructions(canvasId: string, instructions: string) {
  localStorage.setItem(instructionsKey(canvasId), instructions);
  mirror?.write(canvasId);
}

export function getExportLayout(): ExportLayout {
  return localStorage.getItem(EXPORT_LAYOUT_STORAGE_KEY) === "canvas" ? "canvas" : "stacked";
}

export function setExportLayout(layout: ExportLayout) {
  localStorage.setItem(EXPORT_LAYOUT_STORAGE_KEY, layout);
}
