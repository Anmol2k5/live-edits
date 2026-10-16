import type { AnyEffect, EffectPosition, Entrance } from "./effectSchemas";

/**
 * Pure playback mapping shared by the editor preview. It mirrors the OBS
 * overlay player's element choice (`public/obs-overlay.html`) field for
 * field so a saved effect behaves identically in preview and in OBS:
 *
 * - image kinds (png/jpg/webp/gif) and template frames → <img>
 * - video kinds (mp4/webm) → <video> (clip trim, volume, muted)
 * - audio kinds (mp3/ogg/wav) → <audio> + fallback still
 * - fullscreen cutaways → cover-positioned video/image
 *
 * The overlay cannot import this module (zero-build single file), so the
 * parity matrix in `__tests__/playback.test.ts` pins both sides to the
 * same expectations. Timing/queueing always goes through the shared
 * `EffectScheduler` core — never a second engine.
 */

export type PlaybackElement = "img" | "video" | "audio";

export interface PlaybackPlan {
  element: PlaybackElement;
  /** Resolved media URL (object URL in preview, /media/… or /templates/… in OBS). */
  src: string;
  /** Fallback still shown behind audio; null when none. */
  fallbackSrc: string | null;
  volume: number;
  muted: boolean;
  clipStartMs: number | null;
  clipEndMs: number | null;
  /** Visible window after trim is applied. */
  visibleMs: number;
  position: EffectPosition;
  entrance: Entrance;
  exit: Entrance;
  positionClass: string;
  alt: string;
}

export function positionClassFor(position: EffectPosition): string {
  switch (position) {
    case "fullscreen":
      return "effect--fullscreen";
    case "top-left":
      return "effect--corner effect--top-left";
    case "top-right":
      return "effect--corner effect--top-right";
    case "bottom-left":
      return "effect--corner effect--bottom-left";
    case "bottom-right":
      return "effect--corner effect--bottom-right";
    case "center":
      return "";
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function elementForFile(name: string | null): PlaybackElement {
  if (!name) return "img";
  const ext = extensionOf(name);
  if ([".mp4", ".webm"].includes(ext)) return "video";
  if ([".mp3", ".ogg", ".wav"].includes(ext)) return "audio";
  return "img";
}

export interface PlaybackInput {
  effect: AnyEffect;
  /** Resolved URL for the effect's mediaFile (or "" when unavailable). */
  mediaUrl: string;
  /** Template frame URL used for frame effects and audio fallback. */
  templateUrl: string;
}

export function effectToPlayback(input: PlaybackInput): PlaybackPlan {
  const { effect, mediaUrl, templateUrl } = input;
  const kind = effect.kind;
  const mediaFile =
    kind === "frame"
      ? null
      : (effect as { mediaFile?: string }).mediaFile ?? null;
  const element = kind === "frame" ? "img" : elementForFile(mediaFile);
  const src =
    kind === "frame"
      ? templateUrl
      : mediaFile
        ? mediaUrl || `/media/${mediaFile}`
        : templateUrl;
  const fallbackSrc = element === "audio" ? templateUrl : null;
  const volume =
    "volume" in effect && typeof effect.volume === "number" ? effect.volume : 1;
  const clipStartMs =
    "clipStartMs" in effect ? (effect.clipStartMs ?? null) : null;
  const clipEndMs = "clipEndMs" in effect ? (effect.clipEndMs ?? null) : null;
  const durationMs = effect.durationMs;
  const visibleMs =
    clipStartMs !== null && clipEndMs !== null
      ? Math.min(durationMs, clipEndMs - clipStartMs)
      : durationMs;
  const position =
    "position" in effect ? effect.position : ("center" as EffectPosition);
  const entrance =
    "entrance" in effect ? effect.entrance : ("pop" as Entrance);
  const exit = "exit" in effect ? effect.exit : ("fade" as Entrance);
  return {
    element,
    src,
    fallbackSrc,
    volume,
    muted:
      "muted" in effect && typeof effect.muted === "boolean"
        ? effect.muted
        : false,
    clipStartMs,
    clipEndMs,
    visibleMs,
    position,
    entrance,
    exit,
    positionClass: positionClassFor(position),
    alt: `${effect.moment} reaction`,
  };
}
