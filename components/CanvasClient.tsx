"use client";

import { useEffect, useState } from "react";
import { restoreFolder } from "@/lib/folder";
import { getCanvas, loadNodes } from "@/lib/storage";
import dynamic from "next/dynamic";

// The canvas reads localStorage on first render, so it is client-only.
const Canvas = dynamic(() => import("./Canvas"), { ssr: false });

export default function CanvasClient({ canvasId }: { canvasId: string }) {
  const [readyId, setReadyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    restoreFolder().then(() => {
      // Validate before mounting the editor and enabling autosave.
      getCanvas(canvasId);
      loadNodes(canvasId);
      if (active) setReadyId(canvasId);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not load saved canvases.");
    });
    return () => { active = false; };
  }, [canvasId]);
  if (error) return <div role="alert" className="p-8 text-red-700">{error} Reload after resolving the storage or folder error.</div>;
  if (readyId !== canvasId) return <div role="status" className="p-8 text-neutral-500">Loading saved canvas…</div>;
  return <Canvas key={canvasId} canvasId={canvasId} />;
}
