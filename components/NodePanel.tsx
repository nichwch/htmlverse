"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useReactFlow } from "@xyflow/react";
import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH } from "@/lib/types";
import type { PromptFlowNode } from "./PromptNode";
import { KindIcon, kindTextClass, outputKind } from "./nodeKinds";
import { NodePreviewContent, type NodeOutput } from "./NodePreview";

import { ExpandIcon } from "./icons";
import { useNodeFullscreen } from "./CanvasContext";
import { photoSources } from "@/lib/photos";

const CARD_WIDTH = 240;
const CARD_GAP = 8;
const EDGE_PADDING = 8;

function nodeOutput(node: PromptFlowNode): NodeOutput {
  return {
    tab: node.data.tab ?? "chat",
    html: node.data.html,
    markdown: node.data.markdown ?? null,
    drawing: node.data.drawing ?? null,
    wireframe: node.data.wireframe ?? [],
    photo: photoSources(node.data)[0] ?? null,
    photos: photoSources(node.data),
    width: node.width ?? DEFAULT_NODE_WIDTH,
    height: node.height ?? DEFAULT_NODE_HEIGHT,
  };
}

/**
 * A collapsible index of every named node, sitting under the top bar; hidden
 * entirely while nothing is named. Rows are colored by the node's output
 * type; clicking pans the canvas to the node, double-clicking the name
 * renames it, and hovering shows a preview of its current contents.
 */
export default function NodePanel({ nodes }: { nodes: PromptFlowNode[] }) {
  const { open: openFullscreen } = useNodeFullscreen();
  const { fitView, updateNodeData } = useReactFlow<PromptFlowNode>();
  const [collapsed, setCollapsed] = useState(false);
  const [hovered, setHovered] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // A row being renamed stays put even while the draft name is empty.
  const named = nodes.filter((n) => n.data.name?.trim() || n.id === editingId);
  const hoveredNode = hovered ? (named.find((n) => n.id === hovered.id) ?? null) : null;

  if (!named.length) return null;

  function jumpTo(id: string) {
    fitView({ nodes: [{ id }], duration: 600, padding: 0.15, maxZoom: 1 });
  }

  const card =
    hovered && hoveredNode && hoveredNode.id !== editingId
      ? (() => {
          const output = nodeOutput(hoveredNode);
          const cardHeight = Math.round(output.height * (CARD_WIDTH / output.width));
          return {
            output,
            height: cardHeight,
            left: hovered.anchor.right + CARD_GAP,
            top: Math.max(
              EDGE_PADDING,
              Math.min(hovered.anchor.top, window.innerHeight - cardHeight - EDGE_PADDING)
            ),
          };
        })()
      : null;

  return (
    <div className="absolute top-[62px] left-[15px] z-10 w-48 border border-neutral-300 bg-white">
      <button
        className="flex w-full items-center justify-between p-2 text-left text-neutral-500 hover:text-neutral-900"
        onClick={() => setCollapsed(!collapsed)}
        title={collapsed ? "show node list" : "hide node list"}
      >
        nodes
        <span aria-hidden>{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="max-h-[50vh] overflow-y-auto border-t border-neutral-200">
          {named.map((node) => {
            const kind = outputKind(node.data.tab);
            return (
              <div
                key={node.id}
                className="flex w-full cursor-pointer items-center gap-2 px-2 py-1 hover:bg-neutral-50"
                onClick={() => jumpTo(node.id)}
                onMouseEnter={(e) =>
                  setHovered({ id: node.id, anchor: e.currentTarget.getBoundingClientRect() })
                }
                onMouseLeave={() => setHovered(null)}
                title="click to jump — double-click the name to rename"
              >
                <KindIcon kind={kind} className={`shrink-0 ${kindTextClass(kind)}`} />
                {editingId === node.id ? (
                  <input
                    ref={(el) => el?.focus()}
                    className="min-w-0 flex-1 border border-neutral-300 px-1 outline-none focus:border-neutral-900"
                    value={node.data.name ?? ""}
                    spellCheck={false}
                    onChange={(e) => updateNodeData(node.id, { name: e.target.value })}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === "Escape") setEditingId(null);
                    }}
                    onBlur={() => setEditingId(null)}
                  />
                ) : (
                  <span
                    className="min-w-0 flex-1 truncate"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditingId(node.id);
                    }}
                  >
                    {node.data.name}
                  </span>
                )}
                <button className="shrink-0 p-1 text-neutral-400 hover:text-neutral-900" title="Open fullscreen" aria-label={`Open ${node.data.name} fullscreen`} onClick={(event) => { event.stopPropagation(); setHovered(null); openFullscreen(node.id); }}><ExpandIcon /></button>
              </div>
            );
          })}
        </div>
      )}
      {card &&
        hoveredNode &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 overflow-hidden border border-neutral-300 bg-white shadow-sm"
            style={{ left: card.left, top: card.top, width: CARD_WIDTH, height: card.height }}
          >
            <NodePreviewContent
              target={card.output}
              name={hoveredNode.data.name?.trim() ?? ""}
              cardWidth={CARD_WIDTH}
            />
          </div>,
          document.body
        )}
    </div>
  );
}
