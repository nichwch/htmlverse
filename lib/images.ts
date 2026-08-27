/** Longest edge after downscaling; plenty for the model to read a screenshot. */
const MAX_DIMENSION = 1400;
/** Files already smaller than this skip re-encoding entirely. */
const KEEP_ORIGINAL_BYTES = 300_000;

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("could not read image"));
    reader.readAsDataURL(file);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode image"));
    img.src = src;
  });
}

/**
 * Turns a pasted/dropped image into a data URL sized for both the model and
 * localStorage: downscaled to MAX_DIMENSION and re-encoded as JPEG. Screenshots
 * survive this fine; transparency is flattened onto white.
 */
export async function prepareImage(file: File): Promise<string> {
  const original = await readAsDataURL(file);
  const img = await loadImage(original);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height, 1));
  if (scale === 1 && file.size <= KEEP_ORIGINAL_BYTES) return original;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/**
 * Grabs the current webcam frame as a JPEG data URL, downscaled like
 * prepareImage. Mirroring bakes in the flip the preview shows, so the photo
 * matches what the user saw.
 */
export function captureFrame(video: HTMLVideoElement, mirror = false): string {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(video.videoWidth, video.videoHeight, 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d")!;
  if (mirror) {
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}
