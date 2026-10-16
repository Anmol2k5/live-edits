import {
  parseAnyEffect,
  type AnyEffect,
  type EffectKind,
} from "../effects/effectSchemas";
import type { MomentType } from "../templates/schemas";

let effectCounter = 0;

export function generateEffectId(kind: EffectKind): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const suffix = c?.randomUUID
    ? c.randomUUID().slice(0, 8)
    : `${Date.now()}-${(effectCounter += 1)}`;
  return `effect-${kind}-${suffix}`;
}

/**
 * Field-level patch with full schema validation. Invalid trims, volumes,
 * durations, priorities and cooldowns come back as per-field messages —
 * nothing half-applied.
 */
export function applyEffectPatch(
  effect: AnyEffect,
  patch: Partial<Record<string, unknown>>
): { ok: true; effect: AnyEffect } | { ok: false; errors: Record<string, string> } {
  try {
    return { ok: true, effect: parseAnyEffect({ ...effect, ...patch }) };
  } catch (err) {
    return { ok: false, errors: flattenIssues(err) };
  }
}

function flattenIssues(err: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  const issues = (err as { issues?: Array<{ path: Array<string | number>; message: string }> })
    .issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return { _form: err instanceof Error ? err.message : String(err) };
  }
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[issue.path.length - 1]) : "_form";
    if (!(key in errors)) errors[key] = issue.message;
  }
  return errors;
}

export interface NewEffectOptions {
  kind: EffectKind;
  moment?: MomentType;
  mediaFile?: string;
  templateId?: string;
  name?: string;
}

/** Validated effect factory — every creation path funnels through here. */
export function createEffect(options: NewEffectOptions): AnyEffect {
  const moment = options.moment ?? "wow";
  const base = {
    id: generateEffectId(options.kind),
    name:
      options.name?.trim() ||
      `${options.kind} ${moment}`,
    moment,
    durationMs: 2700,
    delayMs: 0,
    cooldownMs: 4000,
    priority: 50,
    queue: "replace",
    enabled: true,
  } as const;
  switch (options.kind) {
    case "frame":
      return parseAnyEffect({
        ...base,
        kind: "frame",
        templateId: options.templateId ?? "wow-1",
        durationMs: 8000,
        zIndex: 100,
        opacity: 1,
      });
    case "image":
      if (!options.mediaFile) throw new Error("Image effects need a media file.");
      return parseAnyEffect({ ...base, kind: "image", mediaFile: options.mediaFile });
    case "video":
      if (!options.mediaFile) throw new Error("Video effects need a media file.");
      return parseAnyEffect({
        ...base,
        kind: "video",
        mediaFile: options.mediaFile,
        muted: false,
      });
    case "audio":
      if (!options.mediaFile) throw new Error("Audio effects need a media file.");
      return parseAnyEffect({
        ...base,
        kind: "audio",
        mediaFile: options.mediaFile,
        ...(options.templateId ? { templateId: options.templateId } : {}),
      });
    case "cutaway":
      if (!options.mediaFile) throw new Error("Cutaways need a media file.");
      return parseAnyEffect({
        ...base,
        kind: "cutaway",
        mediaFile: options.mediaFile,
        position: "fullscreen",
        muted: false,
      });
    case "popup":
      if (!options.mediaFile && !options.templateId) {
        throw new Error("Popups need a media file or a template.");
      }
      return parseAnyEffect({
        ...base,
        kind: "popup",
        ...(options.mediaFile ? { mediaFile: options.mediaFile } : {}),
        ...(options.templateId ? { templateId: options.templateId } : {}),
      });
  }
}
