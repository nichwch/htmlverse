import type { NodePhoto, PromptNodeData } from "./types";

/** Read old canvases without rewriting or duplicating their image data. */
export function nodePhotos(data: PromptNodeData): NodePhoto[] {
  return data.photos ?? (data.photo ? [{
    id: "legacy-photo",
    name: "Photo 1",
    src: data.photo,
    strokes: data.photoStrokes ?? [],
    marked: data.photoMarked ?? null,
  }] : []);
}

export function photoSources(data: PromptNodeData): string[] {
  return nodePhotos(data).map((photo) => photo.marked ?? photo.src);
}
