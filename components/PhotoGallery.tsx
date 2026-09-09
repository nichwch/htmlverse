"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { DrawStroke, NodePhoto } from "@/lib/types";
import { rasterizePhoto } from "@/lib/drawing";
import { isImageFile, prepareImage } from "@/lib/images";
import { PhotoEditor, type PhotoPaneHandle, type PhotoEditorHandle } from "./PhotoPane";
import type { DrawingSettings } from "./DrawingPane";
import { WebcamCapture } from "./WebcamCapture";

export function PhotoGallery({ photos, activeId, onSelect, settings, onAdd, onCommit, handleRef }: {
  photos: NodePhoto[];
  activeId: string | null;
  onSelect: (id: string) => void;
  settings: DrawingSettings;
  onAdd: (photos: NodePhoto[]) => void;
  onCommit: (id: string, strokes: DrawStroke[], marked: string | null) => void;
  handleRef: Ref<PhotoPaneHandle>;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<PhotoEditorHandle>(null);
  const busyRef = useRef(false);
  const [spacious, setSpacious] = useState(false);
  const [focused, setFocused] = useState(false);
  const [webcam, setWebcam] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const active = photos.find((photo) => photo.id === activeId) ?? photos[0];
  const index = active ? photos.indexOf(active) : 0;
  const grid = spacious && photos.length > 1 && !focused;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => setSpacious(wrap.clientWidth >= 580 && wrap.clientHeight >= 340));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useImperativeHandle(handleRef, () => ({
    undo: () => {
      if (grid && active && active.strokes.length) {
        const strokes = active.strokes.slice(0, -1);
        void rasterizePhoto(active.src, strokes).then((marked) => onCommit(active.id, strokes, strokes.length ? marked : null));
      } else editorRef.current?.undo();
    },
    clearDrawings: () => {
      if (grid && active) onCommit(active.id, [], null);
      else editorRef.current?.clearDrawings();
    },
    upload: () => inputRef.current?.click(),
    startWebcam: () => setWebcam(true),
  }));

  async function handleFiles(files: FileList | File[]) {
    if (busyRef.current) return;
    const images = [...files].filter(isImageFile);
    if (!images.length) { setError("Choose an image file to add to this gallery."); return; }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const added: NodePhoto[] = [];
    let failed = 0;
    // Decode one at a time to keep large selections from exhausting browser memory.
    for (const file of images) {
      try {
        added.push({ id: crypto.randomUUID(), name: file.name, src: await prepareImage(file), strokes: [], marked: null });
      } catch { failed++; }
    }
    if (added.length) { onAdd(added); onSelect(added[0].id); setFocused(false); }
    if (failed) setError(`${failed} ${failed === 1 ? "image could" : "images could"} not be opened. Try JPEG, PNG, or WebP.`);
    busyRef.current = false;
    setBusy(false);
  }

  function select(id: string) { onSelect(id); setFocused(true); }
  function step(delta: number) { select(photos[(index + delta + photos.length) % photos.length].id); }

  return <div ref={wrapRef} className={`photo-gallery nodrag nowheel relative flex h-full w-full flex-col overflow-hidden ${dragging ? "ring-2 ring-inset ring-neutral-500" : ""}`}
    onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); setDragging(false); void handleFiles(event.dataTransfer.files); }}
    onKeyDown={(event) => {
      if (photos.length < 2 || (event.target as HTMLElement).tagName === "INPUT") return;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault(); event.stopPropagation(); step(event.key === "ArrowRight" ? 1 : -1);
      }
    }}>
    {webcam ? <WebcamCapture onCancel={() => setWebcam(false)} onCapture={(src) => {
      const photo = { id: crypto.randomUUID(), name: `Camera photo ${photos.length + 1}`, src, strokes: [], marked: null };
      onAdd([photo]); onSelect(photo.id); setWebcam(false); setFocused(false);
    }} /> : <>
      {photos.length > 0 && <div className="photo-gallery-bar">
        <div className="flex min-w-0 items-center gap-3">
          {spacious && photos.length > 1 && focused ? <button className="photo-control" onClick={() => setFocused(false)}>← Gallery</button> : <span className="text-neutral-500">{photos.length === 1 ? "Photo" : "Gallery"}</span>}
          <span className="tabular-nums text-neutral-400">{grid ? `${photos.length} photos` : `${index + 1} / ${photos.length}`}</span>
        </div>
        <button className="photo-control shrink-0" disabled={busy} onClick={() => inputRef.current?.click()}>+ Add photos</button>
      </div>}
      {grid ? <div className="photo-gallery-grid">
        {photos.map((photo, i) => <button key={photo.id} className="photo-gallery-tile" aria-current={photo.id === active?.id ? "true" : undefined} onClick={() => select(photo.id)} aria-label={`Open photo ${i + 1}: ${photo.name}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded data URL */}
          <img src={photo.marked ?? photo.src} alt={photo.name} loading="lazy" draggable={false} />
          <span className="photo-gallery-caption"><span className="truncate">{photo.name}</span><span className="text-neutral-400">{String(i + 1).padStart(2, "0")}</span></span>
        </button>)}
        <button className="photo-gallery-add" onClick={() => inputRef.current?.click()} disabled={busy}><span aria-hidden className="text-2xl">+</span>Add photos</button>
      </div> : active ? <>
        <div className="relative min-h-0 flex-1">
          <PhotoEditor key={active.id} photo={active.src} strokes={active.strokes} settings={settings}
            onCommit={(strokes, marked) => onCommit(active.id, strokes, marked)} handleRef={editorRef} />
          {photos.length > 1 && <>
            <button className="photo-gallery-arrow left-3" onClick={() => step(-1)} aria-label="Previous photo">‹</button>
            <button className="photo-gallery-arrow right-3" onClick={() => step(1)} aria-label="Next photo">›</button>
          </>}
        </div>
        {photos.length > 1 && <div className="photo-gallery-strip" aria-label="Photo thumbnails">
          {photos.map((photo, i) => <button key={photo.id} aria-label={`View photo ${i + 1}: ${photo.name}`} aria-pressed={photo.id === active.id}
            ref={(element) => { if (element && photo.id === active.id) element.scrollIntoView({ block: "nearest", inline: "nearest" }); }}
            className="photo-gallery-thumb" onClick={() => select(photo.id)}>
            {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded data URL */}
            <img src={photo.marked ?? photo.src} alt="" draggable={false} />
          </button>)}
        </div>}
      </> : <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="mb-1 flex h-14 w-14 items-center justify-center rounded-xl border border-neutral-200 bg-white text-neutral-400" aria-hidden>▧</div>
        <p className="text-neutral-600">A place for your references</p>
        <p className="text-neutral-400">Drop photos here, or choose a few to get started.</p>
        <button className="photo-control border border-neutral-300 bg-white px-4 py-2" onClick={() => inputRef.current?.click()} disabled={busy}>Upload photos</button>
        <button className="text-neutral-400 hover:text-neutral-900" onClick={() => setWebcam(true)}>or take a photo</button>
      </div>}
    </>}
    {busy && <div role="status" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-neutral-900 px-4 py-2 text-white shadow-sm">Adding photos…</div>}
    {error && <div role="alert" className="flex items-center justify-between gap-2 border-t border-red-200 bg-red-50 px-3 py-2 text-red-700">{error}<button onClick={() => setError(null)} aria-label="Dismiss upload error">×</button></div>}
    <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(event) => {
      if (event.target.files) void handleFiles(event.target.files);
      event.target.value = "";
    }} />
  </div>;
}
