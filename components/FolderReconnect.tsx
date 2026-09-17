"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import {
  getFolderStatus,
  isFolderSupported,
  renewFolderPermission,
  restoreFolder,
  subscribeToFolder,
} from "@/lib/folder";

/**
 * Reconnects the remembered folder no matter which page the session starts on
 * — without this, opening a canvas directly never restored the mirror, and
 * edits silently stopped reaching the folder until the home page was visited.
 * Everywhere but home (whose settings already offer reconnect), surfaces the
 * one-click renew when Chrome has dropped the grant.
 */
export default function FolderReconnect() {
  const status = useSyncExternalStore(subscribeToFolder, getFolderStatus, getFolderStatus);
  const pathname = usePathname();

  useEffect(() => {
    restoreFolder().catch(() => {});
  }, []);

  if (!isFolderSupported()) return null;
  if (status.error || status.conflicts.length) return (
    <div role="status" className="fixed right-3 bottom-3 z-[70] max-w-sm border border-amber-300 bg-amber-50 p-3 text-amber-900">
      {status.error ? <p>Folder save problem: {status.error}</p> : <>
        <p>Competing versions were preserved as separate canvases:</p>
        {status.conflicts.map((name) => <p key={name}>{name}</p>)}
      </>}
      <p className="mt-1">Recovery snapshots are kept in .canvaschat-backups inside your save folder.</p>
    </div>
  );
  if (!status.needsPermission || pathname === "/") return null;
  return (
    <button
      className="fixed right-3 bottom-3 z-50 border border-neutral-300 bg-white px-2 py-1 text-neutral-500 hover:border-neutral-900 hover:text-neutral-900"
      onClick={() => { void renewFolderPermission().then((connected) => { if (connected) window.location.reload(); }).catch(() => {}); }}
    >
      reconnect {status.name}
    </button>
  );
}
