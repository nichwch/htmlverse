import type { NodeTab } from "@/lib/types";

/** What a node's output is, given its selected tab; chat renders html. */
export type OutputKind = "html" | "md" | "draw" | "wire" | "photo";

export function outputKind(tab: NodeTab | undefined | null): OutputKind {
  switch (tab) {
    case "md":
    case "draw":
    case "wire":
    case "photo":
      return tab;
    default:
      return "html";
  }
}

const CHIP_COLORS: Record<OutputKind, string> = {
  html: "bg-red-100 border-red-300 text-red-500",
  md: "bg-blue-100 border-blue-300 text-blue-500",
  draw: "bg-green-100 border-green-300 text-green-600",
  wire: "bg-yellow-100 border-yellow-300 text-yellow-600",
  photo: "bg-orange-100 border-orange-300 text-orange-600",
};

const TEXT_COLORS: Record<OutputKind, string> = {
  html: "text-red-500",
  md: "text-blue-500",
  draw: "text-green-600",
  wire: "text-yellow-600",
  photo: "text-orange-600",
};

/**
 * Icon parts rather than finished markup, so the same set renders at chip size
 * in React, at tab size in the node header, and as a string in the
 * imperatively-built chips of the contenteditable composer.
 */
type IconSpec = { attrs: string; body: string };

const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.5"';
const ROUND = 'stroke-linecap="round" stroke-linejoin="round"';

/** Chat has no output type of its own — it renders html — but needs a glyph. */
type IconKey = OutputKind | "chat" | "capture";

const ICONS: Record<IconKey, IconSpec> = {
  capture: { attrs: `${STROKE} ${ROUND}`, body: '<path d="M5 2H2v3m9-3h3v3M2 11v3h3m9-3v3h-3"/><path d="M6 6h5v5H6z"/>' },
  chat: {
    attrs: `${STROKE} ${ROUND}`,
    body: '<path d="M2.25 3.25h11.5v7.5H7.5L4.5 13.5v-2.75H2.25z"/>',
  },
  html: {
    attrs: `${STROKE} ${ROUND}`,
    body: '<path d="M5 4.5 1.5 8 5 11.5"/><path d="m11 4.5 3.5 3.5-3.5 3.5"/><path d="m9.25 2.5-2.5 11"/>',
  },
  md: {
    attrs: `${STROKE} ${ROUND}`,
    body: '<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M6 8h4M6 11h4"/>',
  },
  draw: {
    attrs: `${STROKE} ${ROUND}`,
    body: '<path d="m3 13 .9-3.2 7.5-7.5 2.3 2.3-7.5 7.5L3 13z"/><path d="m9.9 3.8 2.3 2.3"/>',
  },
  wire: {
    attrs: STROKE,
    body: '<rect x="2.5" y="2.5" width="11" height="11"/>',
  },
  photo: {
    attrs: `${STROKE} ${ROUND}`,
    body: '<rect x="2" y="3" width="12" height="10"/><circle cx="10.5" cy="6.5" r="1"/><path d="m2.5 11 3.5-3.5 3 3 2-2 2.5 2.5"/>',
  },
};

/** Size used inside mention chips and the node list. */
const CHIP_ICON_SIZE = 11;

function iconSvg(key: IconKey, size: number): string {
  const { attrs, body } = ICONS[key];
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" ${attrs} aria-hidden="true">${body}</svg>`;
}

/** The glyph for a tab, which is its output type except for chat. */
export function tabIconKey(tab: NodeTab): IconKey {
  return tab === "chat" || tab === "capture" ? tab : outputKind(tab);
}

/**
 * inline-flex centers the trailing icon against the label; an inline-flex box
 * takes its baseline from its first item, so the chip still sits on the
 * surrounding text baseline.
 */
export const MENTION_CHIP_BASE =
  "mention-chip mx-0.5 inline-flex items-center gap-1 px-1.5 border";

export function mentionChipClass(kind: OutputKind): string {
  return `${MENTION_CHIP_BASE} ${CHIP_COLORS[kind]}`;
}

/** Fallback style for chips whose node has been deleted or renamed. */
export const MENTION_CHIP_MISSING = `${MENTION_CHIP_BASE} ${CHIP_COLORS.html} opacity-50`;

export function kindIconSvg(kind: OutputKind): string {
  return iconSvg(kind, CHIP_ICON_SIZE);
}

export function kindTextClass(kind: OutputKind): string {
  return TEXT_COLORS[kind];
}

export function KindIcon({ kind, className }: { kind: OutputKind; className?: string }) {
  return (
    <span
      className={`inline-flex ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: iconSvg(kind, CHIP_ICON_SIZE) }}
    />
  );
}

/** The tab-bar glyph for a node tab, at a comfortable click size. */
export function TabIcon({ tab, className }: { tab: NodeTab; className?: string }) {
  return (
    <span
      className={`inline-flex ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: iconSvg(tabIconKey(tab), 14) }}
    />
  );
}
