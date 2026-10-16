import { useEffect, useRef } from "react";
import { effectToPlayback, type PlaybackInput } from "../effects/playback";

interface PreviewStageProps {
  input: PlaybackInput | null;
  /** 0–1 progress through the visible window. */
  progress: number;
  statusText: string;
}

/**
 * Transparent 16:9 stage rendering the SAME playback mapping the OBS
 * overlay uses (`effectToPlayback` parity). Timers live in the parent
 * (single effect preview or the shared-scheduler sequence player) — this
 * component only renders and releases.
 */
export function PreviewStage({ input, progress, statusText }: PreviewStageProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const plan = input ? effectToPlayback(input) : null;

  useEffect(() => {
    const video = videoRef.current;
    if (video && plan?.clipStartMs !== null && plan?.clipStartMs !== undefined) {
      const apply = (): void => {
        try {
          if (plan.clipStartMs !== null && video.readyState >= 1) {
            video.currentTime = (plan.clipStartMs as number) / 1000;
          }
        } catch {
          // Best effort; a missed trim never blocks the preview.
        }
      };
      if (video.readyState >= 1) apply();
      else video.addEventListener("loadedmetadata", apply, { once: true });
    }
  }, [plan?.src, plan?.clipStartMs]);

  useEffect(
    () => () => {
      // Release on unmount/replace so repeated previews never pile up.
      try {
        videoRef.current?.pause();
      } catch {
        // Ignore teardown races.
      }
      try {
        audioRef.current?.pause();
      } catch {
        // Ignore teardown races.
      }
    },
    [plan?.src]
  );

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
