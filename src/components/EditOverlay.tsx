import { useEffect, useRef } from "react";
import type { EditResult } from "../hooks/useEditComposer";

interface EditOverlayProps {
  edit: EditResult;
  onDismiss: () => void;
  onSave: () => void;
  autoDismissMs?: number;
}

const MOMENT_EMOJI: Record<string, string> = {
  wow: "😲",
  funny: "😂",
  sad: "😢",
};

export function EditOverlay({
  edit,
  onDismiss,
  onSave,
  autoDismissMs = 8000,
}: EditOverlayProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, autoDismissMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [onDismiss, autoDismissMs]);

  return (
    <div className="edit-overlay" onClick={onDismiss}>
      <div className="edit-overlay__card" onClick={(e) => e.stopPropagation()}>
        <div className="edit-overlay__header">
          <span className="edit-overlay__moment-badge">
            {MOMENT_EMOJI[edit.moment] ?? "✨"} {edit.moment.toUpperCase()}
          </span>
          <span className="edit-overlay__template-name">{edit.templateName}</span>
          <button
            className="edit-overlay__close-btn"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
        <img
          className="edit-overlay__image"
          src={edit.url}
          alt={`${edit.moment} moment edit`}
        />
        <div className="edit-overlay__actions">
          <button className="edit-overlay__save-btn" onClick={onSave}>
            💾 Save PNG
          </button>
          <button className="edit-overlay__dismiss-btn" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
