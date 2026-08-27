import {
  SKETCH_HEIGHT,
  SKETCH_WIDTH,
  type DrawImage,
  type DrawItem,
  type DrawLayer,
  type DrawStroke,
} from "./types";
import { loadImage } from "./images";

/** Pan/zoom of the infinite draw surface: screen = world * zoom + (x, y). */
export type DrawView = { x: number; y: number; zoom: number };
export type Bounds = { x: number; y: number; w: number; h: number };

export const MIN_DRAW_ZOOM = 0.15;
export const MAX_DRAW_ZOOM = 6;

/** Breathing room around the content when fitting the view or rasterizing. */
const FIT_PADDING = 32;
const RASTER_PADDING = 24;
/** Rasterized sketches are read by a model, not printed — cap the long edge. */
const MAX_RASTER_DIMENSION = 1400;

/** A legacy fixed-canvas sketch occupies exactly this rect at the origin. */
export const BASE_RECT: Bounds = { x: 0, y: 0, w: SKETCH_WIDTH, h: SKETCH_HEIGHT };

export function clampDrawZoom(zoom: number): number {
  return Math.min(Math.max(zoom, MIN_DRAW_ZOOM), MAX_DRAW_ZOOM);
}

/**
 * Reads the persisted drawing as a flat item list: the layered format is
 * flattened (hidden layers dropped, matching what was on screen), and the
 * original flat stroke list becomes stroke items.
 */
export function resolveItems(
  strokes: DrawStroke[] | undefined,
  drawLayers: DrawLayer[] | undefined,
  items: DrawItem[] | undefined
): DrawItem[] {
  if (items) return items;
  if (drawLayers?.length) {
    return drawLayers.filter((layer) => layer.visible).flatMap((layer) => layer.items);
  }
  return (strokes ?? []).map((stroke) => ({ kind: "stroke" as const, stroke }));
}

/** Extent of everything drawn, stroke widths included, or null when empty. */
export function drawingBounds(items: DrawItem[], hasBase: boolean): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const item of items) {
    if (item.kind === "image") {
      minX = Math.min(minX, item.image.x);
      minY = Math.min(minY, item.image.y);
      maxX = Math.max(maxX, item.image.x + item.image.w);
      maxY = Math.max(maxY, item.image.y + item.image.h);
      continue;
    }
    const stroke = item.stroke;
    const reach = stroke.width / 2;
    for (let i = 0; i < stroke.points.length; i += 2) {
      minX = Math.min(minX, stroke.points[i] - reach);
      maxX = Math.max(maxX, stroke.points[i] + reach);
      minY = Math.min(minY, stroke.points[i + 1] - reach);
      maxY = Math.max(maxY, stroke.points[i + 1] + reach);
    }
  }

  if (hasBase) {
    minX = Math.min(minX, BASE_RECT.x);
    minY = Math.min(minY, BASE_RECT.y);
    maxX = Math.max(maxX, BASE_RECT.x + BASE_RECT.w);
    maxY = Math.max(maxY, BASE_RECT.y + BASE_RECT.h);
  }

  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Centers `bounds` in a viewport of the given size, never zooming past 1:1. */
export function fitView(bounds: Bounds | null, width: number, height: number): DrawView {
  if (!bounds || !width || !height) return { x: 0, y: 0, zoom: 1 };
  const zoom = clampDrawZoom(
    Math.min(width / (bounds.w + FIT_PADDING * 2), height / (bounds.h + FIT_PADDING * 2), 1)
  );
  return {
    x: (width - bounds.w * zoom) / 2 - bounds.x * zoom,
    y: (height - bounds.h * zoom) / 2 - bounds.y * zoom,
    zoom,
  };
}

/** Paints one stroke in world coordinates; the caller sets the transform. */
export function paintStroke(ctx: CanvasRenderingContext2D, stroke: DrawStroke) {
  const { points, color, width } = stroke;
  if (points.length < 2) return;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // A single point is a dot, so a click still leaves a mark.
  if (points.length === 2) {
    ctx.beginPath();
    ctx.arc(points[0], points[1], width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
  ctx.stroke();
}

export function paintStrokes(ctx: CanvasRenderingContext2D, strokes: DrawStroke[]) {
  for (const stroke of strokes) paintStroke(ctx, stroke);
}

function paintItem(
  ctx: CanvasRenderingContext2D,
  item: DrawItem,
  images: ReadonlyMap<string, HTMLImageElement>
) {
  if (item.kind === "stroke") {
    paintStroke(ctx, item.stroke);
    return;
  }
  const img = images.get(item.image.data);
  if (img) ctx.drawImage(img, item.image.x, item.image.y, item.image.w, item.image.h);
}

/**
 * Paints items in order. Image items whose bitmaps are still decoding are
 * skipped; the caller redraws when its cache fills in. An in-progress stroke
 * can be painted on top with `overlay`.
 */
export function paintItems(
  ctx: CanvasRenderingContext2D,
  items: DrawItem[],
  images: ReadonlyMap<string, HTMLImageElement>,
  overlay?: DrawStroke
) {
  for (const item of items) paintItem(ctx, item, images);
  if (overlay) paintStroke(ctx, overlay);
}

/** Distinct image data URLs referenced by the items, for cache warming. */
export function itemImageUrls(items: DrawItem[]): string[] {
  const urls: string[] = [];
  for (const item of items) {
    if (item.kind === "image") urls.push(item.image.data);
  }
  return [...new Set(urls)];
}

/** Decodes every referenced image; corrupt entries are dropped, not fatal. */
export async function loadImageMap(
  urls: string[],
  into?: Map<string, HTMLImageElement>
): Promise<Map<string, HTMLImageElement>> {
  const map = into ?? new Map<string, HTMLImageElement>();
  await Promise.all(
    urls
      .filter((url) => !map.has(url))
      .map(async (url) => {
        try {
          map.set(url, await loadImage(url));
        } catch {
          // A corrupt image item renders as nothing rather than losing the rest.
        }
      })
  );
  return map;
}

/**
 * Flattens the infinite surface into a PNG cropped to its content, which is
 * what @mentions, previews, and exports consume. Returns null for an empty
 * surface so downstream code can treat "nothing drawn" as absent.
 */
export async function rasterizeDrawing(
  items: DrawItem[],
  base: string | null,
  images?: Map<string, HTMLImageElement>
): Promise<string | null> {
  const bounds = drawingBounds(items, Boolean(base));
  if (!bounds) return null;

  const imageMap = await loadImageMap(itemImageUrls(items), images);
  const width = bounds.w + RASTER_PADDING * 2;
  const height = bounds.h + RASTER_PADDING * 2;
  const scale = Math.min(1, MAX_RASTER_DIMENSION / Math.max(width, height));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, -bounds.x * scale + RASTER_PADDING * scale, -bounds.y * scale + RASTER_PADDING * scale);

  if (base) {
    try {
      ctx.drawImage(await loadImage(base), BASE_RECT.x, BASE_RECT.y, BASE_RECT.w, BASE_RECT.h);
    } catch {
      // A corrupt backdrop shouldn't lose the drawing on top of it.
    }
  }
  paintItems(ctx, items, imageMap);

  return canvas.toDataURL("image/png");
}

/** Largest side a flood fill snapshot may cover, in world pixels. */
const MAX_FILL_SIDE = 2048;
/** Per-channel distance from the clicked pixel's color that still counts as the same region. */
const FILL_TOLERANCE = 32;

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function unionBounds(a: Bounds, b: Bounds): Bounds {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * Classic scanline flood fill over a rasterized snapshot of the drawing:
 * clicking fills the contiguous region around `point` (anti-aliasing bridged
 * by FILL_TOLERANCE, edges tucked under the linework with a 1px dilation).
 * The result is a bitmap covering just the filled region, which the caller
 * stores as an image item beneath the linework.
 */
export function floodFillImage(
  items: DrawItem[],
  base: HTMLImageElement | null,
  images: ReadonlyMap<string, HTMLImageElement>,
  point: { x: number; y: number },
  color: string,
  viewport: Bounds
): DrawImage | null {
  let area = drawingBounds(items, Boolean(base));
  area = area ? unionBounds(area, viewport) : viewport;

  // Bound the snapshot, keeping the clicked point inside the clamped rect.
  const side = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);
  if (area.w > MAX_FILL_SIDE) {
    const x = side(point.x - MAX_FILL_SIDE / 2, area.x, area.x + area.w - MAX_FILL_SIDE);
    area = { ...area, x, w: MAX_FILL_SIDE };
  }
  if (area.h > MAX_FILL_SIDE) {
    const y = side(point.y - MAX_FILL_SIDE / 2, area.y, area.y + area.h - MAX_FILL_SIDE);
    area = { ...area, y, h: MAX_FILL_SIDE };
  }
  if (
    point.x < area.x ||
    point.y < area.y ||
    point.x > area.x + area.w ||
    point.y > area.y + area.h
  ) {
    return null;
  }

  const w = Math.max(1, Math.round(area.w));
  const h = Math.max(1, Math.round(area.h));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(1, 0, 0, 1, -area.x, -area.y);
  if (base) ctx.drawImage(base, BASE_RECT.x, BASE_RECT.y, BASE_RECT.w, BASE_RECT.h);
  paintItems(ctx, items, images);

  const pixels = ctx.getImageData(0, 0, w, h).data;
  const sx = Math.round(point.x - area.x);
  const sy = Math.round(point.y - area.y);
  const seed = (sy * w + sx) * 4;
  const r0 = pixels[seed];
  const g0 = pixels[seed + 1];
  const b0 = pixels[seed + 2];

  const matches = (i: number) =>
    Math.abs(pixels[i] - r0) <= FILL_TOLERANCE &&
    Math.abs(pixels[i + 1] - g0) <= FILL_TOLERANCE &&
    Math.abs(pixels[i + 2] - b0) <= FILL_TOLERANCE;

  const mask = new Uint8Array(w * h);
  const stack = [sy * w + sx];
  while (stack.length) {
    const start = stack.pop()!;
    const row = Math.floor(start / w);
    let x = start % w;
    while (x >= 0 && !mask[row * w + x] && matches((row * w + x) * 4)) x--;
    x++;
    let spanAbove = false;
    let spanBelow = false;
    for (; x < w && !mask[row * w + x] && matches((row * w + x) * 4); x++) {
      mask[row * w + x] = 1;
      for (const dy of [-1, 1]) {
        const ny = row + dy;
        if (ny < 0 || ny >= h) continue;
        const ni = ny * w + x;
        const hit = !mask[ni] && matches(ni * 4);
        const flag = dy < 0 ? spanAbove : spanBelow;
        if (hit && !flag) {
          stack.push(ni);
          if (dy < 0) spanAbove = true;
          else spanBelow = true;
        } else if (!hit && flag) {
          if (dy < 0) spanAbove = false;
          else spanBelow = false;
        }
      }
    }
  }

  // Grow the region by a pixel so it tucks under anti-aliased linework.
  const grown = new Uint8Array(mask);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % w;
    if (x > 0) grown[i - 1] = 1;
    if (x < w - 1) grown[i + 1] = 1;
    if (i >= w) grown[i - w] = 1;
    if (i < mask.length - w) grown[i + w] = 1;
  }

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < grown.length; i++) {
    if (!grown[i]) continue;
    minX = Math.min(minX, i % w);
    maxX = Math.max(maxX, i % w);
    minY = Math.min(minY, Math.floor(i / w));
    maxY = Math.max(maxY, Math.floor(i / w));
  }
  if (maxX < 0) return null;

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const [r, g, b] = hexToRgb(color);
  const out = ctx.createImageData(bw, bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (!grown[(minY + y) * w + (minX + x)]) continue;
      const i = (y * bw + x) * 4;
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = 255;
    }
  }

  const patch = document.createElement("canvas");
  patch.width = bw;
  patch.height = bh;
  patch.getContext("2d")!.putImageData(out, 0, 0);
  return {
    x: area.x + minX,
    y: area.y + minY,
    w: bw,
    h: bh,
    data: patch.toDataURL("image/png"),
  };
}

/** Bakes strokes onto a photo at its natural size, for mentions and previews. */
export async function rasterizePhoto(photo: string, strokes: DrawStroke[]): Promise<string> {
  const img = await loadImage(photo);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  paintStrokes(ctx, strokes);
  return canvas.toDataURL("image/jpeg", 0.9);
}
