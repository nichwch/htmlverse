import type { ChatMessage, MessagePart, NodeTab, PromptNodeData, StoredNode } from "./types";
import { formatAnnotations } from "./annotate";
import { photoSources } from "./photos";
import { wireframeToDataUrl } from "./wireframe";

export type Mentionable = {
  id: string;
  name: string;
  /** Colors the chip and picks its icon by the node's output type. */
  tab: NodeTab;
};

export type MentionPart =
  | { type: "text"; value: string }
  | { type: "mention"; name: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches against the actual node names (longest first), so names containing
 * spaces work and "@button v2" doesn't stop at "@button".
 */
function mentionPattern(names: string[]): RegExp | null {
  const candidates = names.filter((n) => n.trim());
  if (!candidates.length) return null;
  const alternatives = candidates
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  return new RegExp(`(?<![\\w@])@(${alternatives})(?![\\w-])`, "g");
}

/** Splits text into plain-text runs and resolved mentions, for chip rendering. */
export function splitMentions(text: string, names: string[]): MentionPart[] {
  const pattern = mentionPattern(names);
  if (!pattern) return [{ type: "text", value: text }];

  const parts: MentionPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parts.push({ type: "text", value: text.slice(cursor, match.index) });
    parts.push({ type: "mention", name: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ type: "text", value: text.slice(cursor) });
  return parts;
}

/** The last few things the user asked of a node summarize its intent well. */
function recentPrompts(messages: ChatMessage[], limit = 3): string[] {
  return messages
    .filter((m): m is ChatMessage & { role: "user" } => m.role === "user")
    .slice(-limit)
    .map((m) => m.content.slice(0, 300));
}

export type MentionContext = {
  text: string;
  /** Image outputs of mentioned nodes, in the order their blocks appear in `text`. */
  images: string[];
};

/**
 * A node's output follows its selected tab: chat and html send the rendered
 * document, md sends the markdown, and draw/wire/photo attach an image.
 */
function nodeOutput(data: PromptNodeData): { text: string; image?: string; images?: string[] } {
  switch (data.tab ?? "chat") {
    case "md":
      return data.markdown?.trim()
        ? { text: `<document type="markdown">\n${data.markdown}\n</document>` }
        : { text: "(nothing written yet)" };
    case "draw":
      return data.drawing
        ? { text: "(output: a hand-drawn sketch, attached to this message as an image)", image: data.drawing }
        : { text: "(nothing drawn yet)" };
    case "wire": {
      const image = wireframeToDataUrl(data.wireframe ?? []);
      return image
        ? { text: "(output: a wireframe, attached to this message as an image)", image }
        : { text: "(empty wireframe)" };
    }
    case "photo": {
      const images = photoSources(data);
      return images.length
        ? { text: `(output: ${images.length} uploaded photo(s), attached in gallery order)`, images }
        : { text: "(no photo uploaded yet)" };
    }
    default:
      return data.html
        ? { text: `<document>\n${data.html}\n</document>` }
        : { text: "(nothing rendered yet)" };
  }
}

export type ReferenceNode = { id: string; data: PromptNodeData };

/** Resolve only unambiguous typed names. Selected chips already carry an ID. */
export function resolveMessageParts(parts: MessagePart[], nodes: ReferenceNode[]): MessagePart[] {
  const byName = new Map<string, ReferenceNode[]>();
  for (const node of nodes) {
    const name = node.data.name?.trim();
    if (name) byName.set(name, [...(byName.get(name) ?? []), node]);
  }
  const names = [...byName].filter(([, matches]) => matches.length === 1).map(([name]) => name);
  return parts.flatMap((part): MessagePart[] => {
    if (part.type === "mention") return [part];
    return splitMentions(part.value, names).map((parsed) => parsed.type === "text" ? parsed : {
      type: "mention", nodeId: byName.get(parsed.name)![0].id, name: parsed.name,
    });
  });
}

export function messageText(parts: MessagePart[]): string {
  return parts.map((part) => part.type === "text" ? part.value : `@${part.name}`).join("");
}

/** Freeze reference outputs in first-mention order, once per referenced ID. */
export function snapshotReferences(parts: MessagePart[], nodes: ReferenceNode[]): MentionContext | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const images: string[] = [];
  const blocks: string[] = [];
  for (const part of parts) {
    if (part.type !== "mention" || seen.has(part.nodeId)) continue;
    seen.add(part.nodeId);
    const node = byId.get(part.nodeId);
    const output = node ? nodeOutput(node.data) : { text: "(referenced node is no longer available)" };
    if (output.image) images.push(output.image);
    if (output.images) images.push(...output.images);
    const prompts = node ? recentPrompts(node.data.messages) : [];
    blocks.push([
      `<referenced-node id=${JSON.stringify(part.nodeId)} name=${JSON.stringify(part.name)}>`,
      output.text,
      prompts.length ? `<recent-prompts>\n${prompts.map((p) => `- ${p}`).join("\n")}\n</recent-prompts>` : "",
      "</referenced-node>",
    ].filter(Boolean).join("\n"));
  }
  if (!blocks.length) return undefined;
  return {
    text: "The following are snapshots of the referenced nodes when this message was sent. Reference images follow the user's attachments, in the order below:\n\n" + blocks.join("\n\n"),
    images,
  };
}

/** One path for first sends, continued conversations, and forks. */
export function userMessageForApi(message: Extract<ChatMessage, { role: "user" }>): ChatMessage {
  const context = message.referenceContext;
  const content = [message.content, context?.recovered ? "Reference context below was recovered from available nodes after this older message was sent; its original context was not saved." : "", context?.text, formatAnnotations(message.annotations ?? [])].filter(Boolean).join("\n\n");
  const images = [...(message.images ?? []), ...(context?.images ?? [])];
  return { role: "user", content, ...(images.length ? { images } : {}) };
}

/** Legacy migration is explicit and idempotent; never refresh an existing snapshot. */
export function migrateMessageReferences<T extends ReferenceNode>(nodes: T[]): T[] {
  return nodes.map((node) => ({ ...node, data: { ...node.data, messages: node.data.messages.map((message) => {
    if (message.role !== "user" || message.parts !== undefined) return message;
    const targets = nodes.filter((target) => target.id !== node.id);
    const parts = resolveMessageParts([{ type: "text", value: message.content }], targets);
    const context = message.referenceContext ?? snapshotReferences(parts, targets);
    return { ...message, parts, ...(context ? { referenceContext: { ...context, recovered: message.referenceContext?.recovered ?? true } } : {}) };
  }) } }));
}

/** Whole-canvas forks remap links to copied nodes; historical snapshots stay frozen. */
export function forkNodes(nodes: StoredNode[], newId: () => string = () => crypto.randomUUID()): StoredNode[] {
  const ids = new Map(nodes.map((node) => [node.id, newId()]));
  return migrateMessageReferences(nodes).map((node) => ({ ...node, id: ids.get(node.id)!, data: {
    ...node.data,
    messages: node.data.messages.map((message) => message.role !== "user" ? message : {
      ...message, parts: message.parts?.map((part) => part.type === "mention" ? { ...part, nodeId: ids.get(part.nodeId) ?? part.nodeId } : part),
    }),
  } }));
}
