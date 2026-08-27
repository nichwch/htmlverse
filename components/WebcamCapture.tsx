"use client";

import { useEffect, useRef, useState } from "react";
import { captureFrame } from "@/lib/images";

/**
 * Live webcam preview that fills the photo pane. Taking a photo hands the
 * frame to onCapture; the stream is released as soon as this unmounts, which
 * includes the user switching tabs on the node.
 */
export function WebcamCapture({
  onCapture,
  onCancel,
}: {
  onCapture: (photo: string) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const [error, setError] = useState<string | null>(
    supported ? null : "this browser has no camera support"
  );

  useEffect(() => {
    if (!supported) return;
    let stream: MediaStream | null = null;
    let cancelled = false;

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } }).then(
      (media) => {
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        if (videoRef.current) videoRef.current.srcObject = media;
      },
      () => setError("camera unavailable — check the browser permission")
    );

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [supported]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function takePhoto() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    onCapture(captureFrame(video, true));
  }

  if (error) {
    return (
      <div className="nodrag flex h-full w-full flex-col items-center justify-center gap-2 text-neutral-400">
        <p>{error}</p>
        <button className="underline hover:text-neutral-900" onClick={onCancel}>
          back
        </button>
      </div>
    );
  }

  return (
    <div className="nodrag nowheel flex h-full w-full flex-col bg-black">
      {/* Mirrored like a mirror, and captureFrame bakes the same flip in. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="min-h-0 flex-1 -scale-x-100 object-contain"
      />
      <div className="flex items-center justify-center gap-4 bg-white p-2">
        <button
          className="border border-neutral-300 px-2 py-1 text-neutral-500 hover:border-neutral-900 hover:text-neutral-900"
          onClick={takePhoto}
        >
          take photo
        </button>
        <button className="text-neutral-500 underline hover:text-neutral-900" onClick={onCancel}>
          cancel
        </button>
      </div>
    </div>
  );
}
