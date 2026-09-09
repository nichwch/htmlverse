"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from "react";
import type { DrawStroke } from "@/lib/types";
import { paintStroke, paintStrokes, rasterizePhoto } from "@/lib/drawing";
import { BRUSH_SIZES, DRAWING_COLORS, type DrawingSettings } from "./DrawingPane";

const MAX_UNDO = 30;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

type Contain = { x: number; y: number; w: number; h: number; scale: number };

function containRect(cw: number, ch: number, iw: number, ih: number): Contain {
  const scale = Math.min(cw / iw, ch / ih);
  const w = iw * scale;
  const h = ih * scale;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h, scale };
}

export type PhotoEditorHandle = {
  undo: () => void;
  clearDrawings: () => void;
};

export type PhotoPaneHandle = PhotoEditorHandle & {
  startWebcam: () => void;
  upload: () => void;
};

/** A single photo and its marks. Uploads and navigation belong to the gallery. */
export function PhotoEditor({
  photo,
  strokes,
  settings,
  onCommit,
  handleRef,
}: {
  photo: string;
  strokes: DrawStroke[];
  settings: DrawingSettings;
  onCommit: (strokes: DrawStroke[], marked: string | null) => void;
  handleRef: Ref<PhotoEditorHandle>;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const containRef = useRef<Contain | null>(null);
  const dragRef = useRef<DrawStroke | null>(null);
  const undoRef = useRef<DrawStroke[][]>([]);
  const strokesRef = useRef(strokes);

  useEffect(() => {
    strokesRef.current = strokes;
  }, [strokes]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const img = imageRef.current;
    if (!canvas || !wrap || !img) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#f5f5f5";
    ctx.fillRect(0, 0, width, height);

    const box = containRect(width, height, img.naturalWidth, img.naturalHeight);
    containRef.current = box;
    ctx.drawImage(img, box.x, box.y, box.w, box.h);

    ctx.setTransform(dpr * box.scale, 0, 0, dpr * box.scale, dpr * box.x, dpr * box.y);
    paintStrokes(ctx, strokesRef.current);
    const drag = dragRef.current;
    if (drag) paintStroke(ctx, drag);
  }, []);

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
    if (!photo) {
      imageRef.current = null;
      redraw();
      return;
    }
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      resize();
    };
    img.src = photo;
    return () => { img.onload = null; };
  }, [photo, resize, redraw]);

  useEffect(redraw, [strokes, redraw]);

  async function commit(next: DrawStroke[]) {
    const marked = next.length && photo ? await rasterizePhoto(photo, next) : null;
    onCommit(next, marked);
  }

  useImperativeHandle(handleRef, () => ({
    undo() {
      const previous = undoRef.current.pop() ?? (strokesRef.current.length ? strokesRef.current.slice(0, -1) : undefined);
      if (!previous) return;
      void commit(previous);
    },
    clearDrawings() {
      if (!strokesRef.current.length) return;
      undoRef.current = [...undoRef.current, strokesRef.current].slice(-MAX_UNDO);
      void commit([]);
    },
  }));

  function localPoint(event: React.PointerEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.clientWidth,
      y: ((event.clientY - rect.top) / rect.height) * canvas.clientHeight,
    };
  }

  function toImage(point: { x: number; y: number }) {
    const box = containRef.current;
    if (!box || box.scale === 0) return null;
    const x = (point.x - box.x) / box.scale;
    const y = (point.y - box.y) / box.scale;
    const img = imageRef.current;
    if (!img) return null;
    if (x < 0 || y < 0 || x > img.naturalWidth || y > img.naturalHeight) return null;
    return { x, y };
  }

  function onPointerDown(event: React.PointerEvent) {
    if (event.button !== 0) return;
    const image = toImage(localPoint(event));
    if (!image) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      color: settings.color,
      width: settings.size,
      points: [round(image.x), round(image.y)],
    };
    redraw();
  }

  function onPointerMove(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const image = toImage(localPoint(event));
    if (!image) return;
    drag.points.push(round(image.x), round(image.y));
    redraw();
  }

  function onPointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    undoRef.current = [...undoRef.current, strokesRef.current].slice(-MAX_UNDO);
    void commit([...strokesRef.current, drag]);
  }


  return (
    <div ref={wrapRef} className="h-full w-full overflow-hidden bg-neutral-100">
      <canvas ref={canvasRef} className="nodrag nowheel h-full w-full cursor-crosshair touch-none"
        aria-label="Draw on the selected photo"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp} onContextMenu={(event) => event.preventDefault()} />
    </div>
  );
}

/** The sidebar acts on the currently selected photo. */
export function PhotoToolbar({
  photo,
  photoName,
  hasDrawings,
  settings,
  onUpload,
  onRemove,
  onSettingsChange,
  onUndo,
  onClearDrawings,
  onTakePhoto,
}: {
  photo: string | null;
  photoName?: string;
  hasDrawings: boolean;
  settings: DrawingSettings;
  onUpload: () => void;
  onRemove: () => void;
  onSettingsChange: (settings: DrawingSettings) => void;
  onUndo: () => void;
  onClearDrawings: () => void;
  onTakePhoto: () => void;
}) {
  return (
    <div className="nodrag nowheel min-h-0 flex-1 cursor-auto space-y-4 overflow-y-auto p-3">
      <button
        className="block text-neutral-500 underline hover:text-neutral-900"
        onClick={onUpload}
      >
        {photo ? "add photos" : "upload photos"}
      </button>
      <button className="block text-neutral-500 underline hover:text-neutral-900" onClick={onTakePhoto}>
        take a photo
      </button>
      {photoName && <p className="truncate text-neutral-400" title={photoName}>selected: {photoName}</p>}
      {photo && (
        <button
          className="block text-neutral-500 underline hover:text-red-600"
          onClick={onRemove}
        >
          remove photo
        </button>
      )}
      {photo && (
        <>
          <div>
            <p className="mb-1 text-neutral-400">color</p>
            <div className="flex flex-wrap gap-1">
              {DRAWING_COLORS.map((color) => (
                <button
                  key={color}
                  className={`h-6 w-6 border ${
                    settings.color === color
                      ? "border-neutral-900 ring-1 ring-neutral-900"
                      : "border-neutral-300"
                  }`}
                  style={{ background: color }}
                  onClick={() => onSettingsChange({ ...settings, color, tool: "brush" })}
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
                  onClick={() => onSettingsChange({ ...settings, size })}
                  title={`${size}px`}
                  aria-label={`brush size ${size}px`}
                >
                  <span className="rounded-full bg-current" style={{ width: size, height: size }} />
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-3">
            <button
              className="text-neutral-500 underline hover:text-neutral-900 disabled:text-neutral-300"
              onClick={onUndo}
              disabled={!hasDrawings}
            >
              undo
            </button>
            <button
              className="text-neutral-500 underline hover:text-red-600 disabled:text-neutral-300"
              onClick={onClearDrawings}
              disabled={!hasDrawings}
            >
              clear drawings
            </button>
          </div>
        </>
      )}
      <p className="text-neutral-400">
        draw on the photo to mark it up. with this tab selected, @-mentioning this node from
        another chat attaches all photos as references
      </p>

    </div>
  );
}
