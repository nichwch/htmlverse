"use client";

import { useMemo } from "react";
import type { NodeTab, WireframeElement } from "@/lib/types";
import { withTailwind } from "@/lib/preview";
import { markdownDocument } from "@/lib/markdown";
import { wireframeToDataUrl } from "@/lib/wireframe";

/** A node's current output, as needed to render a small preview of it. */
export type NodeOutput = {
  tab: NodeTab;
  html: string | null;
  markdown: string | null;
  drawing: string | null;
  wireframe: WireframeElement[];
  photo: string | null;
  photos?: string[];
  width: number;
  height: number;
};

const EMPTY_NOTES: Record<NodeTab, string> = {
  capture: "no capture yet",
  chat: "nothing rendered yet",
  html: "nothing rendered yet",
  md: "nothing written yet",
  draw: "nothing drawn yet",
  wire: "empty wireframe",
  photo: "no photo yet",
};

/**
 * The content of a preview card for a node, per its selected tab: rendered
 * document, markdown, sketch, wireframe, or photo. Fills its container; mount
 * it only while the card is visible — wireframes rasterize on render.
 */
export function NodePreviewContent({
  target,
  name,
  cardWidth,
}: {
  target: NodeOutput;
  name: string;
  cardWidth: number;
}) {
  const wireframeUrl = useMemo(
    () => (target.tab === "wire" ? wireframeToDataUrl(target.wireframe) : null),
    [target.tab, target.wireframe]
  );

  if (target.tab === "photo" && (target.photos?.length ?? 0) > 1) {
    return <div className="grid h-full grid-cols-2 gap-1 overflow-hidden bg-neutral-100 p-1">
      {target.photos!.slice(0, 4).map((src, index) => <div key={index} className="relative min-h-0 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- local data URL */}
        <img src={src} alt={`@${name} photo ${index + 1}`} className="h-full w-full object-cover" />
        {index === 3 && target.photos!.length > 4 && <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white">+{target.photos!.length - 4}</span>}
      </div>)}
    </div>;
  }

  const image =
    target.tab === "draw" ? target.drawing : target.tab === "photo" ? target.photo : wireframeUrl;

  if (target.tab === "draw" || target.tab === "wire" || target.tab === "photo") {
    return image ? (
      // eslint-disable-next-line @next/next/no-img-element -- data URL preview
      <img src={image} alt={`@${name} preview`} className="h-full w-full bg-white object-contain" />
    ) : (
      <EmptyNote tab={target.tab} />
    );
  }

  const doc =
    target.tab === "md"
      ? target.markdown?.trim()
        ? markdownDocument(target.markdown)
        : null
      : target.html
        ? withTailwind(target.html)
        : null;
  return doc ? (
    <iframe
      className="origin-top-left border-0"
      style={{
        width: target.width,
        height: target.height,
        transform: `scale(${cardWidth / target.width})`,
      }}
      sandbox="allow-scripts"
      srcDoc={doc}
      title={`@${name} preview`}
    />
  ) : (
    <EmptyNote tab={target.tab} />
  );
}

function EmptyNote({ tab }: { tab: NodeTab }) {
  return (
    <div className="flex h-full items-center justify-center text-neutral-400">{EMPTY_NOTES[tab]}</div>
  );
}
