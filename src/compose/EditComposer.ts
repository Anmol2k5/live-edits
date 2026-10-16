import type { Template } from "../templates/schemas";

const FRAME_WIDTH = 800;
const FRAME_HEIGHT = 600;

/**
 * Load an image from a URL, returning a promise.
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

/**
 * True when a video element holds a decodable frame that `captureFrame`
 * can safely screenshot. Camera-dependent PNG composition must stay
 * disabled until this returns true — manual OBS triggers without a
 * webcam take the relay-only path instead.
 */
export function hasValidFrame(video: HTMLVideoElement | null | undefined): boolean {
  if (!video) return false;
  if (video.readyState < 2) return false;
  if (video.srcObject === null) return false;
  return video.videoWidth > 0 && video.videoHeight > 0;
}

/**
 * Grab a screenshot from a video element as a canvas.
 * @throws when the video has no decoded frame yet (zero dimensions).
 */
export function captureFrame(video: HTMLVideoElement): HTMLCanvasElement {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error("Video is not ready — no frame to capture yet.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context for screenshot");
  ctx.drawImage(video, 0, 0);
  return canvas;
}

/**
 * Compose a screenshot with a template frame.
 * Pure function: (screenshot canvas, template) => PNG Blob.
 *
 * Strategy: cover-fit the screenshot into the photo slot (centered crop).
 */
export async function compose(
  screenshot: HTMLCanvasElement,
  template: Template
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_WIDTH;
  canvas.height = FRAME_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context for compositing");

  const slot = template.photoSlot;
  if (
    !Number.isFinite(slot.x) ||
    !Number.isFinite(slot.y) ||
    !Number.isFinite(slot.width) ||
    !Number.isFinite(slot.height) ||
    slot.width <= 0 ||
    slot.height <= 0
  ) {
    throw new Error(`Invalid photo slot in template "${template.id}".`);
  }
  if (!screenshot.width || !screenshot.height) {
    throw new Error("Screenshot has zero dimensions.");
  }

  // Draw screenshot into slot using cover-fit
  ctx.save();

  if (slot.rotationDeg !== 0) {
    const cx = slot.x + slot.width / 2;
    const cy = slot.y + slot.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((slot.rotationDeg * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  // Cover-fit: scale the screenshot to cover the slot, then center-crop
  const srcAspect = screenshot.width / screenshot.height;
  const slotAspect = slot.width / slot.height;

  let sx = 0,
    sy = 0,
    sw = screenshot.width,
    sh = screenshot.height;

  if (srcAspect > slotAspect) {
    // Source is wider — crop sides
    sw = screenshot.height * slotAspect;
    sx = (screenshot.width - sw) / 2;
  } else {
    // Source is taller — crop top/bottom
    sh = screenshot.width / slotAspect;
    sy = (screenshot.height - sh) / 2;
  }

  ctx.drawImage(screenshot, sx, sy, sw, sh, slot.x, slot.y, slot.width, slot.height);
  ctx.restore();

  // Draw frame on top
  const frameImg = await loadImage(template.frameAsset);
  ctx.drawImage(frameImg, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas toBlob returned null"));
      },
      "image/png"
    );
  });
}
