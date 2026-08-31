import { type Template, parseTemplates } from "./schemas";

/**
 * Template frame dimensions: 800x600.
 * Photo slot is centered with padding for the frame border.
 *
 * Each moment type has 2 templates.
 * Frame assets are PNG files in public/templates/.
 */
const RAW_TEMPLATES = [
  // --- WOW ---
  {
    id: "wow-1",
    moment: "wow" as const,
    name: "WOW Shock Frame",
    frameAsset: "/templates/wow-1.png",
    photoSlot: { x: 60, y: 80, width: 680, height: 440, rotationDeg: 0 },
  },
  {
    id: "wow-2",
    moment: "wow" as const,
    name: "WOW Comic Burst",
    frameAsset: "/templates/wow-2.png",
    photoSlot: { x: 80, y: 70, width: 640, height: 460, rotationDeg: -2 },
  },
  // --- FUNNY ---
  {
    id: "funny-1",
    moment: "funny" as const,
    name: "LOL Party Frame",
    frameAsset: "/templates/funny-1.png",
    photoSlot: { x: 60, y: 80, width: 680, height: 440, rotationDeg: 0 },
  },
  {
    id: "funny-2",
    moment: "funny" as const,
    name: "HAHA Neon Frame",
    frameAsset: "/templates/funny-2.png",
    photoSlot: { x: 70, y: 60, width: 660, height: 480, rotationDeg: 1 },
  },
  // --- SAD ---
  {
    id: "sad-1",
    moment: "sad" as const,
    name: "Sad Rain Frame",
    frameAsset: "/templates/sad-1.png",
    photoSlot: { x: 60, y: 80, width: 680, height: 440, rotationDeg: 0 },
  },
  {
    id: "sad-2",
    moment: "sad" as const,
    name: "Sad Drama Frame",
    frameAsset: "/templates/sad-2.png",
    photoSlot: { x: 80, y: 90, width: 640, height: 420, rotationDeg: -1 },
  },
] satisfies Template[];

/** Validated template registry — fails at startup if any template is malformed. */
export const TEMPLATES: Template[] = parseTemplates(RAW_TEMPLATES);

export function getTemplatesForMoment(moment: Template["moment"]): Template[] {
  return TEMPLATES.filter((t) => t.moment === moment);
}

export function getRandomTemplate(moment: Template["moment"]): Template {
  const matching = getTemplatesForMoment(moment);
  return matching[Math.floor(Math.random() * matching.length)];
}
