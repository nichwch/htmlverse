"use client";

import { useState, useSyncExternalStore } from "react";
import {
  disconnectFolder,
  getFolderStatus,
  isFolderSupported,
  renewFolderPermission,
  subscribeToFolder,
  connectFolder,
} from "@/lib/folder";
import { FolderIcon } from "./icons";

function formatTime(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Dismissing the folder picker is a normal outcome, not a failure. */
function isDismissal(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export default function FolderSettings({ onCanvasesChanged }: { onCanvasesChanged: () => void }) {
  const status = useSyncExternalStore(subscribeToFolder, getFolderStatus, getFolderStatus);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const supported = isFolderSupported();

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setNote(null);
    try {
      setNote(await action());
    } catch (err) {
      if (isDismissal(err)) return;
      setNote(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const choose = () =>
    run(async () => {
      const count = await connectFolder();
      onCanvasesChanged();
      return `${count} ${count === 1 ? "canvas" : "canvases"} in the folder`;
    });

  const renew = () =>
    run(async () => {
      const granted = await renewFolderPermission();
      if (!granted) return "permission was not granted";
      onCanvasesChanged();
      return "folder reconnected";
    });

  const stop = () =>
    run(async () => {
      await disconnectFolder();
      return "disconnected — canvases stay in this browser";
    });

  return (
    <div className="border-b border-neutral-200 p-3">
      <span className="mb-1 flex items-center gap-2 text-neutral-500">
        <FolderIcon />
        folder
      </span>

      {!supported ? (
        <p className="text-neutral-400">
          this browser cannot open folders. canvases stay in this browser only — chrome and edge
          support folders.
        </p>
      ) : status.needsPermission ? (
        <>
          <p className="mb-2 text-neutral-500">
            <span className="text-neutral-900">{status.name}</span> needs permission again.
          </p>
          <button
            className="border border-neutral-300 px-2 py-1 text-neutral-500 hover:border-neutral-900 hover:text-neutral-900 disabled:opacity-50"
            onClick={renew}
            disabled={busy}
          >
            reconnect folder
          </button>
        </>
      ) : status.name ? (
        <>
          <p className="mb-2 text-neutral-500">
            saving to <span className="text-neutral-900">{status.name}</span>
            {status.writing
              ? " · saving…"
              : status.savedAt
                ? ` · saved ${formatTime(status.savedAt)}`
                : ""}
          </p>
          <button
            className="border border-neutral-300 px-2 py-1 text-neutral-500 hover:border-neutral-900 hover:text-neutral-900 disabled:opacity-50"
            onClick={stop}
            disabled={busy}
          >
            disconnect
          </button>
        </>
      ) : (
        <>
          <p className="mb-2 text-neutral-400">
            keep canvases in a folder on this machine instead of only in this browser. put the
            folder in a git repo to move it between machines. the folder and this browser are
            merged — nothing is replaced.
          </p>
          <button
            className="border border-neutral-300 px-2 py-1 text-neutral-500 hover:border-neutral-900 hover:text-neutral-900 disabled:opacity-50"
            onClick={choose}
            disabled={busy}
          >
            use a folder
          </button>
        </>
      )}

      {status.skipped.length > 0 && (
        <div className="mt-2 text-amber-600">
          <p>left {status.skipped.length === 1 ? "one file" : `${status.skipped.length} files`} out of the merge:</p>
          {status.skipped.map((file) => (
            <p key={file} className="mt-1">{file}</p>
          ))}
        </div>
      )}
      {status.error && <p className="mt-1 text-red-600">{status.error}</p>}
      {note && <p className="mt-1 text-neutral-500">{note}</p>}
    </div>
  );
}
