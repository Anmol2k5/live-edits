import { z } from "zod/v4";

export const MomentTypeSchema = z.enum(["wow", "funny", "sad"]);
export type MomentType = z.infer<typeof MomentTypeSchema>;

export const PhotoSlotSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  rotationDeg: z.number().default(0),
});

export const TemplateSchema = z.object({
  id: z.string(),
  moment: MomentTypeSchema,
  name: z.string(),
  frameAsset: z.string(),
  photoSlot: PhotoSlotSchema,
});

export type Template = z.infer<typeof TemplateSchema>;

export const ExpressionScoresSchema = z.object({
  neutral: z.number(),
  happy: z.number(),
  sad: z.number(),
  surprised: z.number(),
  angry: z.number(),
  disgusted: z.number(),
  fearful: z.number(),
});

/**
 * Parse and validate a template at load time.
 * Throws with clear message on invalid data.
 */
export function parseTemplate(data: unknown): Template {
  return TemplateSchema.parse(data);
}

/**
 * Parse and validate the full template registry.
 */
export function parseTemplates(data: unknown): Template[] {
  const arr = z.array(TemplateSchema).parse(data);
  // Validate no duplicate IDs
  const ids = new Set<string>();
  for (const t of arr) {
    if (ids.has(t.id)) {
      throw new Error(`Duplicate template ID: ${t.id}`);
    }
    ids.add(t.id);
  }
  return arr;
}
