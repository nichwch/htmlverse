"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { restoreFolder } from "@/lib/folder";
import { createCanvas, deleteCanvas, forkCanvas, listCanvases, loadNodes } from "@/lib/storage";
import type { CanvasMeta, StoredNode } from "@/lib/types";
import CanvasCardPreview from "./CanvasCardPreview";
import SettingsModal from "./SettingsModal";
import { ForkIcon, GearIcon, TrashIcon } from "./icons";

type Entry = CanvasMeta & { nodeCount: number; previewNodes: StoredNode[] };

function read(): Entry[] {
  return listCanvases().map((c) => {
    const nodes = loadNodes(c.id);
    return { ...c, nodeCount: nodes.length, previewNodes: nodes.slice(0, 3) };
  });
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function CanvasList() {
  // Client-only component (loaded with ssr: false), so localStorage is safe to read up front.
  const [canvases, setCanvases] = useState<Entry[]>(read);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const router = useRouter();

  // A connected folder is the copy that travels between machines, so what it
  // holds replaces this browser's canvases on the way in.
  useEffect(() => {
    restoreFolder()
      .then((connected) => {
        if (connected) setCanvases(read());
      })
      .catch(() => {});
  }, []);

  function create() {
    const meta = createCanvas();
    router.push(`/canvas/${meta.id}`);
  }

  function fork(id: string) {
    if (forkCanvas(id)) setCanvases(read());
  }

  function remove(id: string, name: string) {
    if (!confirm(`delete "${name}"? this cannot be undone.`)) return;
    deleteCanvas(id);
    setCanvases(read());
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="mb-6 flex items-center gap-3">
        <span>proto</span>
        <span className="flex-1" />
        <button
          className="text-neutral-500 hover:text-neutral-900"
          onClick={() => setSettingsOpen(true)}
          title="settings"
          aria-label="settings"
        >
          <GearIcon />
        </button>
        <button
          className="border border-neutral-300 bg-white px-2 py-1 text-neutral-500 hover:text-neutral-900"
          onClick={create}
        >
          new canvas
        </button>
      </div>

      {canvases.length === 0 ? (
        <p className="text-neutral-400">no canvases yet — create one to start prototyping.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          {canvases.map((c) => (
            <div
              key={c.id}
              className="group relative border border-neutral-300 bg-white hover:border-neutral-900"
            >
              <Link href={`/canvas/${c.id}`} className="block focus-visible:outline-2 focus-visible:outline-offset-4" aria-label={`Open ${c.name}`}>
                <CanvasCardPreview nodes={c.previewNodes} />
                <div className="truncate px-3 pt-3">{c.name}</div>
                <div className="px-3 pt-1 pb-3 text-neutral-400">
                  {c.nodeCount} {c.nodeCount === 1 ? "node" : "nodes"} · {formatDate(c.updatedAt)}
                </div>
              </Link>
              <div className="absolute top-2 right-2 flex gap-2 border border-neutral-200 bg-white/95 p-1.5 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                <button
                  className="text-neutral-400 hover:text-neutral-900"
                  onClick={() => fork(c.id)}
                  title="fork canvas"
                  aria-label="fork canvas"
                >
                  <ForkIcon />
                </button>
                <button
                  className="text-neutral-400 hover:text-red-600"
                  onClick={() => remove(c.id, c.name)}
                  title="delete canvas"
                  aria-label="delete canvas"
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onCanvasesChanged={() => setCanvases(read())}
        />
      )}
    </div>
  );
}
