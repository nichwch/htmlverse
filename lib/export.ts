import { markdownDocument, renderMarkdown } from "./markdown";
import { withTailwind } from "./preview";
import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  type ExportLayout,
  type StoredNode,
} from "./types";

/** Row tolerance when sorting into reading order: nodes within this many px count as the same row. */
const ROW_TOLERANCE = 80;
const CANVAS_PADDING = 40;

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function hasMarkdown(node: StoredNode): boolean {
  return Boolean(node.data.markdown?.trim());
}

/** A node exports its markdown when it has any, otherwise its generated html. */
function documentFor(node: StoredNode): string | null {
  if (hasMarkdown(node)) return markdownDocument(node.data.markdown!);
  return node.data.html ? withTailwind(node.data.html) : null;
}

function frame(node: StoredNode, style: string): string {
  const doc = documentFor(node);
  if (!doc) return "";
  return `<iframe class="node-frame" style="${style}" sandbox="allow-scripts" srcdoc="${escapeAttribute(doc)}" loading="lazy"></iframe>`;
}

function sortForReading(nodes: StoredNode[]): StoredNode[] {
  return [...nodes].sort((a, b) => {
    const sameRow = Math.abs(a.position.y - b.position.y) < ROW_TOLERANCE;
    return sameRow ? a.position.x - b.position.x : a.position.y - b.position.y;
  });
}

function stackedBody(nodes: StoredNode[]): string {
  return sortForReading(nodes)
    .map((node) => {
      // Markdown is inlined rather than framed so the export stays one readable document.
      if (hasMarkdown(node)) {
        return `<section class="prose prose-neutral mx-auto max-w-2xl px-6 py-10">\n${renderMarkdown(node.data.markdown!)}\n</section>`;
      }
      if (!node.data.html) return "";
      const height = node.height ?? DEFAULT_NODE_HEIGHT;
      return `<section class="mx-auto w-full max-w-5xl px-6 py-6">${frame(node, `width:100%;height:${height}px;border:1px solid #e5e5e5;`)}</section>`;
    })
    .filter(Boolean)
    .join("\n");
}

function canvasBody(nodes: StoredNode[]): string {
  // Crop to the bounding box of the nodes so exported boards have no empty margins.
  const minX = Math.min(...nodes.map((n) => n.position.x));
  const minY = Math.min(...nodes.map((n) => n.position.y));
  const maxX = Math.max(...nodes.map((n) => n.position.x + (n.width ?? DEFAULT_NODE_WIDTH)));
  const maxY = Math.max(...nodes.map((n) => n.position.y + (n.height ?? DEFAULT_NODE_HEIGHT)));

  const tiles = nodes
    .map((node) => {
      const width = node.width ?? DEFAULT_NODE_WIDTH;
      const height = node.height ?? DEFAULT_NODE_HEIGHT;
      const left = node.position.x - minX + CANVAS_PADDING;
      const top = node.position.y - minY + CANVAS_PADDING;
      return frame(
        node,
        `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;border:1px solid #e5e5e5;background:#fff;`
      );
    })
    .filter(Boolean)
    .join("\n");

  const boardWidth = maxX - minX + CANVAS_PADDING * 2;
  const boardHeight = maxY - minY + CANVAS_PADDING * 2;
  return `<div style="position:relative;width:${boardWidth}px;height:${boardHeight}px;">\n${tiles}\n</div>`;
}

export function exportCanvas(
  nodes: StoredNode[],
  canvasName: string,
  layout: ExportLayout
): string {
  // Nodes toggled off in the header stay out of the exported document.
  const exportable = nodes.filter((n) => !n.data.hidden && (hasMarkdown(n) || n.data.html));
  const body = exportable.length
    ? layout === "canvas"
      ? canvasBody(exportable)
      : stackedBody(exportable)
    : `<p style="padding:40px;color:#a3a3a3;">This canvas has nothing to export yet.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(canvasName)}</title>
<script src="https://cdn.tailwindcss.com?plugins=typography"></script>
<style>
  body { margin: 0; background: #fafafa; color: #171717; }
  .node-frame { display: block; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function slugify(canvasName: string): string {
  return canvasName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "canvas";
}

export function filenameFor(canvasName: string): string {
  return `${slugify(canvasName)}.html`;
}

/**
 * The editable canvas: nodes, chat, drawings — same shape as a folder-backed
 * file, id in the name and all, so a copy dropped into a synced folder imports
 * as that canvas instead of shadowing it.
 */
export function filenameForCanvas(canvasName: string, canvasId: string): string {
  return `${slugify(canvasName)}-${canvasId}.json`;
}
