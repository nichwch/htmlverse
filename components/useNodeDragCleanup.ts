"use client";

import { useCallback, useEffect, useRef } from "react";

/** Keep React Flow's mouse drag from surviving a missed mouseup. */
export function useNodeDragCleanup() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const mousePosition = useRef<{ clientX: number; clientY: number } | null>(null);

  const onNodeDragStart = useCallback((event: MouseEvent | TouchEvent) => {
    // Touch drags already have a touchcancel path in React Flow.
    if (!(event instanceof MouseEvent)) return;
    mousePosition.current = { clientX: event.clientX, clientY: event.clientY };
    canvasRef.current?.setAttribute("data-node-dragging", "true");
  }, []);

  const onNodeDragStop = useCallback(() => {
    mousePosition.current = null;
    canvasRef.current?.removeAttribute("data-node-dragging");
  }, []);

  useEffect(() => {
    function finishDrag() {
      const position = mousePosition.current;
      if (!position) return;
      onNodeDragStop();
      // End the underlying d3 gesture too: clearing node.dragging alone leaves
      // its window listeners and React Flow's auto-pan loop running.
      window.dispatchEvent(new MouseEvent("mouseup", {
        ...position,
        view: window,
        bubbles: true,
        cancelable: true,
        buttons: 0,
        button: 0,
      }));
    }

    function onMouseMove(event: MouseEvent) {
      if (!mousePosition.current) return;
      if ((event.buttons & 1) === 0) {
        // Run before d3's capture listener so returning to the window after
        // releasing elsewhere cannot move the node one more time.
        event.stopImmediatePropagation();
        finishDrag();
        return;
      }
      mousePosition.current = { clientX: event.clientX, clientY: event.clientY };
    }

    function onVisibilityChange() {
      if (document.hidden) finishDrag();
    }

    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("blur", finishDrag);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      finishDrag();
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("blur", finishDrag);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [onNodeDragStop]);

  return { canvasRef, onNodeDragStart, onNodeDragStop };
}
