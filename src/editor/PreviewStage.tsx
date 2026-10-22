import { useEffect, useRef } from "react";
import { effectToPlayback, type PlaybackInput } from "../effects/playback";

interface PreviewStageProps {
  input: PlaybackInput | null;
  /** 0–1 progress through the visible window. */
  progress: number;
  statusText: string;
  paused?: boolean;
  /** Initial position within this preview window, after any trim start. */
  offsetMs?: number;
}

/**
 * Transparent 16:9 stage rendering the SAME playback mapping the OBS
 * overlay uses (`effectToPlayback` parity). Timers live in the parent
 * (single effect preview or the shared-scheduler sequence player) — this
 * component only renders and releases.
 */
export function PreviewStage({ input, progress, statusText, paused = false, offsetMs = 0 }: PreviewStageProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const plan = input ? effectToPlayback(input) : null;
  const clipStartMs = plan?.clipStartMs ?? 0;

  useEffect(() => {
    const media = videoRef.current ?? audioRef.current;
    if (media) {
      const apply = (): void => {
        try {
          if (media.readyState >= 1) {
            media.currentTime = (clipStartMs + offsetMs) / 1000;
          }
        } catch {
          // Best effort; a missed trim never blocks the preview.
        }
      };
      if (media.readyState >= 1) apply();
      else media.addEventListener("loadedmetadata", apply, { once: true });
      return () => media.removeEventListener("loadedmetadata", apply);
    }
  }, [input, clipStartMs, offsetMs]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    return () => {
      // Release on unmount/replace so repeated previews never pile up.
      try {
        video?.pause();
      } catch {
        // Ignore teardown races.
      }
      try {
        audio?.pause();
      } catch {
        // Ignore teardown races.
      }
    };
  }, [plan?.src]);

  useEffect(() => {
    const media = videoRef.current ?? audioRef.current;
    if (!media) return;
    if (paused) media.pause();
    else void media.play()?.catch(() => undefined);
  }, [paused, input]);

  const percent = Math.max(0, Math.min(1, progress));

  return (
    <section className="editor-panel editor-preview" aria-label="Live effect preview">
      <h2>Preview</h2>
      <div className="editor-stage" data-testid="preview-stage">
        {plan === null ? (
          <p className="editor-empty">
            Nothing to preview. Select an effect and press Preview — the stage
            stays transparent when idle, exactly like OBS.
          </p>
        ) : (
          <div className={`effect ${plan.positionClass}`.trim()} key={plan.src}>
            {plan.element === "video" && (
              <video
                ref={(el) => {
                  videoRef.current = el;
                  if (el) {
                    el.volume = plan.volume;
                    el.muted = plan.muted;
                  }
                }}
                src={plan.src}
                autoPlay
                playsInline
              />
            )}
            {plan.element === "audio" && (
              <>
                {plan.fallbackSrc && (
                  <img src={plan.fallbackSrc} alt={plan.alt} />
                )}
                <audio
                  ref={(el) => {
                    audioRef.current = el;
                    if (el) el.volume = plan.volume;
                  }}
                  src={plan.src}
                  autoPlay
                />
              </>
            )}
            {plan.element === "img" && <img src={plan.src} alt={plan.alt} />}
          </div>
        )}
      </div>
      <div className="editor-row">
        <div
          className="editor-progress"
          role="progressbar"
          aria-label="Effect progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent * 100)}
        >
          <div
            className="editor-progress__fill"
            style={{ width: `${percent * 100}%` }}
          />
        </div>
        <span className="editor-status" role="status" aria-live="polite">
          {statusText}
        </span>
      </div>
    </section>
  );
}
