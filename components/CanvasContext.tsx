"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

/** Nodes are rendered by React Flow, so the canvas they belong to arrives by context. */
const CanvasIdContext = createContext<string | null>(null);

export const CanvasIdProvider = CanvasIdContext.Provider;

export function useCanvasId(): string {
  const id = useContext(CanvasIdContext);
  if (!id) throw new Error("useCanvasId must be used within a CanvasIdProvider");
  return id;
}


const FullscreenContext = createContext<{ nodeId: string | null; open: (id: string | null) => void }>({ nodeId: null, open: () => {} });

export function FullscreenProvider({ children }: { children: ReactNode }) {
  const [nodeId, open] = useState<string | null>(null);
  return <FullscreenContext.Provider value={{ nodeId, open }}>{children}</FullscreenContext.Provider>;
}

export function useNodeFullscreen() { return useContext(FullscreenContext); }
