import { useState, useCallback, useEffect, useRef } from "react";
import { compose, captureFrame } from "../compose/EditComposer";
import { getRandomTemplate } from "../templates/templates";
import type { Template } from "../templates/schemas";
import type { MomentType } from "../detector/MomentDetector";

export interface EditResult {
  blob: Blob;
  url: string;
  moment: MomentType;
  templateName: string;
  capturedAt: number;
}

export interface EditComposerHookResult {
  currentEdit: EditResult | null;
  isComposing: boolean;
  composeError: string | null;
  /** Backwards-compatible alias for `composeError` (OBS branch naming). */
  error: string | null;
  trigger: (video: HTMLVideoElement, moment: MomentType) => void;
  triggerWithTemplate: (video: HTMLVideoElement, template: Template) => void;
  dismiss: () => void;
  save: () => void;
}

/** Latest-request-wins composition; all created object URLs are released. */
export function useEditComposer(): EditComposerHookResult {
  const [currentEdit, setCurrentEdit] = useState<EditResult | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const currentRef = useRef<EditResult | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Invalidate in-flight composes and release the object URL.
      requestRef.current++;
      if (currentRef.current) URL.revokeObjectURL(currentRef.current.url);
      currentRef.current = null;
    };
  }, []);

  const triggerWithTemplate = useCallback((video: HTMLVideoElement, template: Template) => {
    const request = ++requestRef.current;
    setIsComposing(true);
    setComposeError(null);

    // Synchronous fast path so capture failures (e.g. video not ready)
    // surface immediately instead of hanging `isComposing`.
    let screenshot: HTMLCanvasElement;
    try {
      screenshot = captureFrame(video);
    } catch (cause: unknown) {
      console.error("Compositing failed:", cause);
      setComposeError(cause instanceof Error ? cause.message : String(cause));
      setIsComposing(false);
      return;
    }

    compose(screenshot, template).then(
      (blob) => {
        if (!mountedRef.current || request !== requestRef.current) return;
        const result: EditResult = {
          blob,
          url: URL.createObjectURL(blob),
          moment: template.moment,
          templateName: template.name,
          capturedAt: Date.now(),
        };
        const previous = currentRef.current;
        currentRef.current = result;
        setCurrentEdit(result);
        if (previous) URL.revokeObjectURL(previous.url);
        setIsComposing(false);
      },
      (cause: unknown) => {
        if (!mountedRef.current || request !== requestRef.current) return;
        console.error("Compositing failed:", cause);
        setComposeError(cause instanceof Error ? cause.message : String(cause));
        setIsComposing(false);
      }
    );
  }, []);

  const trigger = useCallback((video: HTMLVideoElement, moment: MomentType) => {
    triggerWithTemplate(video, getRandomTemplate(moment));
  }, [triggerWithTemplate]);

  const dismiss = useCallback(() => {
    // Invalidate in-flight work so a stale compose cannot reappear.
    requestRef.current++;
    setIsComposing(false);
    const current = currentRef.current;
    currentRef.current = null;
    setCurrentEdit(null);
    if (current) URL.revokeObjectURL(current.url);
  }, []);

  const save = useCallback(() => {
    if (!currentEdit) return;
    const a = document.createElement("a");
    a.href = currentEdit.url;
    a.download = `moment-${currentEdit.moment}-${currentEdit.capturedAt}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [currentEdit]);

  return { currentEdit, isComposing, composeError, error: composeError, trigger, triggerWithTemplate, dismiss, save };
}
