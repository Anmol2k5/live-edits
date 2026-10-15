import { getTemplateById } from "../templates/templates";
import type { TriggerEvent } from "../trigger/TriggerEvent";

const RELAY = "http://127.0.0.1:4190";

/** Explicit opt-in: only reaction metadata, never webcam frames, leaves the desktop UI. */
export async function publishOverlayTrigger(
  event: TriggerEvent,
  publishToken: string,
  mediaFile: string
): Promise<number> {
  if (!publishToken) throw new Error("Enter the relay publish token.");
  const moment = event.source === "manual" ? getTemplateById(event.templateId).moment : event.moment;
  const templateId = event.source === "manual" ? event.templateId : moment + "-1";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(RELAY + "/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + publishToken },
      body: JSON.stringify({
        moment, templateId,
        ...(mediaFile.trim() ? { mediaFile: mediaFile.trim() } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("OBS relay returned HTTP " + response.status);
    const result: { connectedOverlays?: number } = await response.json();
    return result.connectedOverlays ?? 0;
  } finally {
    clearTimeout(timeout);
  }
}
