"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { DrawItem, DrawStroke } from "@/lib/types";
import {
  clampDrawZoom,
  drawingBounds,
  fitView,
  floodFillImage,
  itemImageUrls,
  paintItems,
  rasterizeDrawing,
  BASE_RECT,
  type DrawView,
} from "@/lib/drawing";
import { loadImage } from "@/lib/images";

export type DrawingTool = "brush" | "eraser" | "fill" | "pan";

export type DrawingSettings = {
  color: string;
  size: number;
  tool: DrawingTool;
};

export type DrawingPaneHandle = {
  undo: () => void;
  clear: () => void;
  fit: () => void;
};

export const DRAWING_COLORS = [
  "#171717",
  "#737373",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
];

export const BRUSH_SIZES = [2, 4, 8, 16];

export const DEFAULT_DRAWING_SETTINGS: DrawingSettings = {
  color: DRAWING_COLORS[0],
  size: 4,
  tool: "brush",
};

/** The eraser is just a fat white brush — the surface is flattened onto white. */
const ERASER_SCALE = 4;
const MAX_UNDO = 30;
/** World-space spacing of the backdrop dots, so panning is visible. */
const GRID_SPACING = 32;
/** The decoded-image cache is dropped and lazily rebuilt past this size. */
const MAX_CACHE_IMAGES = 200;

type Drag =
  | { mode: "draw"; stroke: DrawStroke }
  | { mode: "pan"; startX: number; startY: number; originX: number; originY: number };

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/**
 * The main-panel drawing surface for a node's draw tab: an infinite canvas —
 * scroll to zoom, middle-drag or hold space to pan, or use the pan tool.
 * Content is a flat list of vector strokes and flood-fill bitmaps in world
 * space, flattened to a PNG on commit, which is what mentions and previews
 * consume.
 */
export function DrawingPane({
  items,
  base,
  settings,
  onCommit,
  onZoomChange,
  handleRef,
}: {
  items: DrawItem[];
  /** Legacy fixed-canvas sketch, pinned at the origin beneath the items. */
  base: string | null;
  settings: DrawingSettings;
  onCommit: (items: DrawItem[], drawing: string | null) => void;
  /** Zoom only, so panning doesn't re-render the surrounding node. */
  onZoomChange: (zoom: number) => void;
  handleRef: Ref<DrawingPaneHandle>;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseImageRef = useRef<HTMLImageElement | null>(null);
  const imageCacheRef = useRef(new Map<string, HTMLImageElement>());
  const dragRef = useRef<Drag | null>(null);
  const undoRef = useRef<DrawItem[][]>([]);
  const spaceRef = useRef(false);
  const viewRef = useRef<DrawView>({ x: 0, y: 0, zoom: 1 });
  const itemsRef = useRef(items);
  const commitQueueRef = useRef(Promise.resolve());

  const [view, setViewState] = useState<DrawView>({ x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);

  // Mirror of render state for the imperative paint path and event handlers.
  // Effects run in order, so this lands before the repaint effect below.
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const setView = useCallback(
    (next: DrawView) => {
      if (next.zoom !== viewRef.current.zoom) onZoomChange(next.zoom);
      viewRef.current = next;
      setViewState(next);
    },
    [onZoomChange]
  );

  /** Full repaint: grid, legacy backdrop, every committed item. */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const { x, y, zoom } = viewRef.current;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    // Grid dots are drawn in screen space so they stay crisp at any zoom.
    const step = GRID_SPACING * zoom;
    if (step >= 6) {
      ctx.fillStyle = "#e5e5e5";
      for (let gx = ((x % step) + step) % step; gx < width; gx += step) {
        for (let gy = ((y % step) + step) % step; gy < height; gy += step) {
          ctx.fillRect(gx, gy, 1, 1);
        }
      }
    }

    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * x, dpr * y);
    const baseImage = baseImageRef.current;
    if (baseImage) {
      ctx.drawImage(baseImage, BASE_RECT.x, BASE_RECT.y, BASE_RECT.w, BASE_RECT.h);
    }

    const drag = dragRef.current;
    paintItems(
      ctx,
      itemsRef.current,
      imageCacheRef.current,
      drag?.mode === "draw" ? drag.stroke : undefined
    );
  }, []);

  /** Backing store follows the element size and pixel ratio. */
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(wrap.clientWidth * dpr));
    const height = Math.max(1, Math.round(wrap.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    redraw();
  }, [redraw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    resize();
    return () => observer.disconnect();
  }, [resize]);

  useEffect(() => {
    if (!base) {
      baseImageRef.current = null;
      redraw();
      return;
    }
    const img = new Image();
    img.onload = () => {
      baseImageRef.current = img;
      redraw();
    };
    img.src = base;
  }, [base, redraw]);

  // Decode fill bitmaps referenced by the items; each arrival repaints once.
  useEffect(() => {
    const cache = imageCacheRef.current;
    if (cache.size > MAX_CACHE_IMAGES) cache.clear();
    for (const url of itemImageUrls(items)) {
      if (cache.has(url)) continue;
      loadImage(url)
        .then((img) => {
          cache.set(url, img);
          redraw();
        })
        .catch(() => undefined);
    }
  }, [items, redraw]);

  useEffect(redraw, [items, view, redraw]);

  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    setView(
      fitView(
        drawingBounds(itemsRef.current, Boolean(base)),
        wrap.clientWidth,
        wrap.clientHeight
      )
    );
  }, [base, setView]);

  // Open on whatever was drawn before, wherever on the surface it lives.
  useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // Serialized: rasterizing is async, and two commits in flight must land in
  // the order they were made, never clobbering each other's item list.
  function commit(next: DrawItem[]) {
    const run = async () =>
      onCommit(next, await rasterizeDrawing(next, base, imageCacheRef.current));
    commitQueueRef.current = commitQueueRef.current.then(run).catch(() => undefined);
  }

  function pushUndo() {
    undoRef.current = [...undoRef.current, itemsRef.current].slice(-MAX_UNDO);
  }

  function undo() {
    const previous = undoRef.current.pop();
    if (!previous) return;
    commit(previous);
  }

  // Space is the usual hold-to-pan modifier; Cmd/Ctrl+Z undoes. Both are
  // ignored while typing elsewhere.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === "Space" && !isTypingTarget(event.target)) {
        spaceRef.current = true;
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "z" &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        undo();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  });

  useImperativeHandle(handleRef, () => ({
    undo,
    clear() {
      if (!itemsRef.current.length) return;
      pushUndo();
      commit([]);
    },
    fit,
  }));

  /** Pointer position in canvas pixels, absorbing the React Flow zoom. */
  function localPoint(event: React.PointerEvent | React.WheelEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.clientWidth,
      y: ((event.clientY - rect.top) / rect.height) * canvas.clientHeight,
    };
  }

  function toWorld(point: { x: number; y: number }, current: DrawView) {
    return { x: (point.x - current.x) / current.zoom, y: (point.y - current.y) / current.zoom };
  }

  function fillAt(point: { x: number; y: number }) {
    const canvas = canvasRef.current!;
    const topLeft = toWorld({ x: 0, y: 0 }, viewRef.current);
    const bottomRight = toWorld(
      { x: canvas.clientWidth, y: canvas.clientHeight },
      viewRef.current
    );
    const fill = floodFillImage(
      itemsRef.current,
      baseImageRef.current,
      imageCacheRef.current,
      toWorld(point, viewRef.current),
      settings.color,
      { x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y }
    );
    if (!fill) return;
    pushUndo();
    // Fills go beneath the linework, so outlines stay on top.
    commit([{ kind: "image", image: fill }, ...itemsRef.current]);
  }

  function onWheel(event: React.WheelEvent) {
    const cursor = localPoint(event);
    const current = viewRef.current;
    const zoom = clampDrawZoom(current.zoom * Math.exp(-event.deltaY * 0.0015));
    const world = toWorld(cursor, current);
    setView({ x: cursor.x - world.x * zoom, y: cursor.y - world.y * zoom, zoom });
  }

  function onPointerDown(event: React.PointerEvent) {
    const canvas = canvasRef.current!;
    const point = localPoint(event);
    const wantsPan = event.button === 1 || settings.tool === "pan" || spaceRef.current;

    if (wantsPan) {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      dragRef.current = {
        mode: "pan",
        startX: point.x,
        startY: point.y,
        originX: viewRef.current.x,
        originY: viewRef.current.y,
      };
      setPanning(true);
      return;
    }

    if (event.button !== 0) return;

    if (settings.tool === "fill") {
      fillAt(point);
      return;
    }

    canvas.setPointerCapture(event.pointerId);
    const world = toWorld(point, viewRef.current);
    const eraser = settings.tool === "eraser";
    dragRef.current = {
      mode: "draw",
      stroke: {
        color: eraser ? "#ffffff" : settings.color,
        width: eraser ? settings.size * ERASER_SCALE : settings.size,
        points: [round(world.x), round(world.y)],
      },
    };
    redraw();
  }

  function onPointerMove(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const point = localPoint(event);

    if (drag.mode === "pan") {
      setView({
        x: drag.originX + (point.x - drag.startX),
        y: drag.originY + (point.y - drag.startY),
        zoom: viewRef.current.zoom,
      });
      return;
    }

    const world = toWorld(point, viewRef.current);
    drag.stroke.points.push(round(world.x), round(world.y));
    redraw();
  }

  function onPointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    if (drag?.mode !== "draw") return;

    pushUndo();
    commit([...itemsRef.current, { kind: "stroke", stroke: drag.stroke }]);
  }

  const cursor = panning
    ? "cursor-grabbing"
    : settings.tool === "pan"
      ? "cursor-grab"
      : "cursor-crosshair";

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-white">
      <canvas
        ref={canvasRef}
        className={`nodrag nowheel h-full w-full touch-none ${cursor}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />
      <p className="pointer-events-none absolute right-2 bottom-1 text-neutral-300">
        scroll to zoom · space or middle-drag to pan · ⌘Z undo
      </p>
    </div>
  );
}

/** Sub-pixel precision is invisible here and doubles the stored size. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The sidebar for the draw tab: color, brush size, tool, undo/clear/fit. */
export function DrawingToolbar({
  settings,
  zoom,
  onChange,
  onUndo,
  onClear,
  onFit,
}: {
  settings: DrawingSettings;
  zoom: number;
  onChange: (settings: DrawingSettings) => void;
  onUndo: () => void;
  onClear: () => void;
  onFit: () => void;
}) {
  return (
    <div className="nodrag nowheel min-h-0 flex-1 cursor-auto space-y-4 overflow-y-auto p-3">
      <div>
        <p className="mb-1 text-neutral-400">color</p>
        <div className="flex flex-wrap gap-1">
          {DRAWING_COLORS.map((color) => (
            <button
              key={color}
              className={`h-6 w-6 border ${
                settings.color === color && (settings.tool === "brush" || settings.tool === "fill")
                  ? "border-neutral-900 ring-1 ring-neutral-900"
                  : "border-neutral-300"
              }`}
              style={{ background: color }}
              onClick={() => onChange({ ...settings, color, tool: "brush" })}
              title={color}
              aria-label={`color ${color}`}
            />
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1 text-neutral-400">size</p>
        <div className="flex gap-1">
          {BRUSH_SIZES.map((size) => (
            <button
              key={size}
              className={`flex h-7 w-7 items-center justify-center border ${
                settings.size === size
                  ? "border-neutral-900 text-neutral-900"
                  : "border-neutral-300 text-neutral-400 hover:text-neutral-900"
              }`}
              onClick={() => onChange({ ...settings, size })}
              title={`${size}px`}
              aria-label={`brush size ${size}px`}
            >
              <span className="rounded-full bg-current" style={{ width: size, height: size }} />
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1 text-neutral-400">tool</p>
        <div className="flex gap-1">
          {(["brush", "eraser", "fill", "pan"] as const).map((tool) => (
            <button
              key={tool}
              className={`border px-2 py-0.5 ${
                settings.tool === tool
                  ? "border-neutral-900 text-neutral-900"
                  : "border-neutral-300 text-neutral-400 hover:text-neutral-900"
              }`}
              onClick={() => onChange({ ...settings, tool })}
            >
              {tool}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1 text-neutral-400">view</p>
        <div className="flex items-baseline gap-3">
          <button className="text-neutral-500 underline hover:text-neutral-900" onClick={onFit}>
            fit
          </button>
          <span className="text-neutral-400">{Math.round(zoom * 100)}%</span>
        </div>
      </div>
      <div className="flex gap-3">
        <button className="text-neutral-500 underline hover:text-neutral-900" onClick={onUndo}>
          undo
        </button>
        <button className="text-neutral-500 underline hover:text-red-600" onClick={onClear}>
          clear
        </button>
      </div>
    </div>
  );
}
