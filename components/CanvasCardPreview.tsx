"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH, type StoredNode } from "@/lib/types";
import { photoSources } from "@/lib/photos";
import { NodePreviewContent } from "./NodePreview";
import { KindIcon, kindTextClass, outputKind } from "./nodeKinds";
import styles from "./CanvasCardPreview.module.css";

/** Only mount the small, capped set of document previews while on screen. */
export default function CanvasCardPreview({ nodes }: { nodes: StoredNode[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={container} className={styles.stage} aria-hidden="true" inert>
      {nodes.length === 0 ? (
        <div className={styles.empty}>a blank canvas<br /><span>room for your next idea</span></div>
      ) : nodes.map((node, index) => {
        const data = node.data;
        const kind = outputKind(data.tab);
        const photos = photoSources(data);
        const name = data.name || `node ${index + 1}`;
        const latestMessage = data.messages.findLast((message) => message.role === "user");
        return (
          <div key={node.id} className={styles.card} data-layer={index} style={{ zIndex: nodes.length - index }}>
            <div className={styles.header}>
              <KindIcon kind={kind} className={kindTextClass(kind)} />
              <span className="truncate">{name}</span>
            </div>
            <div className={styles.content}>
              {visible && ((data.tab === "chat" || !data.tab) && !data.html && latestMessage ? (
                <div className={styles.chat}><span>prompt</span><p>{latestMessage.content}</p></div>
              ) : (
                <NodePreviewContent
                  name={name}
                  cardWidth={180}
                  target={{
                    tab: data.tab ?? "chat",
                    html: data.html,
                    markdown: data.markdown ?? null,
                    drawing: data.drawing ?? null,
                    wireframe: data.wireframe ?? [],
                    photo: photos[0] ?? null,
                    photos,
                    width: node.width || DEFAULT_NODE_WIDTH,
                    height: node.height || DEFAULT_NODE_HEIGHT,
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
