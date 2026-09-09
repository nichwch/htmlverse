"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH } from "@/lib/types";
import { KindIcon, MENTION_CHIP_MISSING, mentionChipClass, outputKind } from "./nodeKinds";
import { NodePreviewContent, type NodeOutput } from "./NodePreview";

const CARD_WIDTH = 240;
const CARD_GAP = 6;
const EDGE_PADDING = 8;

/**
 * An @mention in the transcript, colored by the mentioned node's output type.
 * Hovering shows the node's current output — rendered document, markdown,
 * sketch, wireframe, or photo, per its selected tab; clicking pans the canvas
 * to it. The card renders through a portal in screen coordinates — inside the
 * node it would be clipped by the transcript's scroll container and scaled by
 * the canvas zoom.
 */
export default function MentionChip({
  name,
  target,
  onJump,
}: {
  name: string;
  /** null when the mentioned node has been deleted. */
  target: NodeOutput | null;
  onJump: () => void;
}) {
  const chipRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  if (!target) {
    return (
      <span className={MENTION_CHIP_MISSING} title="node not found">
        @{name}
      </span>
    );
  }

  const kind = outputKind(target.tab);
  const width = target.width || DEFAULT_NODE_WIDTH;
  const height = target.height || DEFAULT_NODE_HEIGHT;
  const cardHeight = Math.round(height * (CARD_WIDTH / width));

  // Above the chip when there's room, below otherwise; clamped to the viewport.
  const card = anchor
    ? {
        left: Math.max(
          EDGE_PADDING,
          Math.min(anchor.left, window.innerWidth - CARD_WIDTH - EDGE_PADDING)
        ),
        top:
          anchor.top - CARD_GAP - cardHeight >= EDGE_PADDING
            ? anchor.top - CARD_GAP - cardHeight
            : anchor.bottom + CARD_GAP,
      }
    : null;

  return (
    <>
      <button
        ref={chipRef}
        className={`nodrag ${mentionChipClass(kind)} cursor-pointer`}
        onClick={onJump}
        onMouseEnter={() => setAnchor(chipRef.current?.getBoundingClientRect() ?? null)}
        onMouseLeave={() => setAnchor(null)}
        title="jump to node"
      >
        @{name}
        <KindIcon kind={kind} />
      </button>
      {card &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 overflow-hidden border border-neutral-300 bg-white shadow-sm"
            style={{ left: card.left, top: card.top, width: CARD_WIDTH, height: cardHeight }}
          >
            <NodePreviewContent target={target} name={name} cardWidth={CARD_WIDTH} />
          </div>,
          document.body
        )}
    </>
  );
}
