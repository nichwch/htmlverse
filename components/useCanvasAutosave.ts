"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CanvasConflictError, savedNodesSnapshot, saveNodes } from "@/lib/storage";
import type { StoredNode } from "@/lib/types";

/** Debounce normal edits, but synchronously flush before the page goes away. */
export function useCanvasAutosave(canvasId: string, nodes: StoredNode[]) {
  const [initial] = useState(() => JSON.stringify(nodes));
  const saved = useRef(initial);
  const latest = useRef(nodes);
  const [initialDisk] = useState(() => savedNodesSnapshot(canvasId));
  const disk = useRef(initialDisk);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const flush = useCallback((notify = true): boolean => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    try {
      const current = latest.current;
      const serialized = JSON.stringify(current);
      if (serialized !== saved.current) {
        saveNodes(canvasId, current, disk.current);
        disk.current = serialized;
        saved.current = serialized;
      }
      if (notify) setError(null);
      return true;
    } catch (reason) {
      if (notify) setError(reason instanceof CanvasConflictError ? reason.message : reason instanceof DOMException && reason.name === "QuotaExceededError"
        ? "Browser storage is full. Your latest changes are not saved. Back up this canvas before leaving."
        : "Your latest changes could not be saved. Back up this canvas before leaving.");
      return false;
    }
  }, [canvasId]);

  useLayoutEffect(() => {
    latest.current = nodes;
    // Mounting/measuring a saved canvas must not mark old content as a new edit.
    if (JSON.stringify(nodes) === saved.current) return;
    timer.current = setTimeout(() => flush(), 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [nodes, flush]);

  useEffect(() => {
    const onHidden = () => { if (document.visibilityState === "hidden") flush(); };
    const onPageHide = () => { flush(); };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!flush()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      flush(false);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [flush]);

  return { error, flush };
}
