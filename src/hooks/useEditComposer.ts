import { useState, useCallback } from "react";
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
  trigger: (video: HTMLVideoElement, moment: MomentType) => void;
  triggerWithTemplate: (video: HTMLVideoElement, template: Template) => void;
  dismiss: () => void;
  save: () => void;
}

export function useEditComposer(): EditComposerHookResult {
  const [currentEdit, setCurrentEdit] = useState<EditResult | null>(null);
  const [isComposing, setIsComposing] = useState(false);

  const trigger = useCallback((video: HTMLVideoElement, moment: MomentType) => {
    setIsComposing(true);

    const screenshot = captureFrame(video);
    const template = getRandomTemplate(moment);

    compose(screenshot, template)
      .then((blob) => {
        // Revoke previous URL
        setCurrentEdit((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return null;
        });

        const url = URL.createObjectURL(blob);
        setCurrentEdit({
          blob,
          url,
          moment,
          templateName: template.name,
          capturedAt: Date.now(),
        });
      })
      .catch((err) => {
        console.error("Compositing failed:", err);
      })
      .finally(() => {
        setIsComposing(false);
      });
  }, []);

  const triggerWithTemplate = useCallback((video: HTMLVideoElement, template: Template) => {
    setIsComposing(true);

    const screenshot = captureFrame(video);

    compose(screenshot, template)
      .then((blob) => {
        setCurrentEdit((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return null;
        });

        const url = URL.createObjectURL(blob);
        setCurrentEdit({
          blob,
          url,
          moment: template.moment,
          templateName: template.name,
          capturedAt: Date.now(),
        });
      })
      .catch((err) => {
        console.error("Compositing failed:", err);
      })
      .finally(() => {
        setIsComposing(false);
      });
  }, []);

  const dismiss = useCallback(() => {
    setCurrentEdit((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, []);

  const save = useCallback(() => {
    if (!currentEdit) return;
    const a = document.createElement("a");
    a.href = currentEdit.url;
    a.download = `moment-${currentEdit.moment}-${currentEdit.capturedAt}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [currentEdit]);

  return { currentEdit, isComposing, trigger, triggerWithTemplate, dismiss, save };
}
