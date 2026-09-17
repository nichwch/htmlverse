import type { NodeTab } from "./types";

const TAB_LABELS: Record<NodeTab, string> = {
  capture: "capture",
  chat: "chat",
  html: "html",
  md: "md",
  draw: "drawing",
  wire: "wireframe",
  photo: "photo",
};

/** "wireframe 1", "md 2", … — the smallest number not already taken. */
export function defaultNodeName(tab: NodeTab, taken: (string | undefined)[]): string {
  const names = new Set(taken.filter((n): n is string => Boolean(n?.trim())).map((n) => n.trim()));
  for (let i = 1; ; i++) {
    const candidate = `${TAB_LABELS[tab]} ${i}`;
    if (!names.has(candidate)) return candidate;
  }
}

const DEFAULT_PATTERN = new RegExp(`^(${Object.values(TAB_LABELS).join("|")}) \\d+$`);

/**
 * Whether a name is still an auto-assigned default (or missing). Only such
 * names are re-labeled when the node's tab changes — a hand-picked name is
 * never touched.
 */
export function isDefaultNodeName(name: string | undefined): boolean {
  const trimmed = name?.trim();
  return !trimmed || DEFAULT_PATTERN.test(trimmed);
}

/** Whether a name already carries the label of the given tab ("wireframe 3" for wire). */
export function matchesTabLabel(name: string, tab: NodeTab): boolean {
  return name.startsWith(`${TAB_LABELS[tab]} `);
}
