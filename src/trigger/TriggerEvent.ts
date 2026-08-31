import type { MomentType } from "../templates/schemas";

export type { MomentType };

export type TriggerEvent =
  | { source: "ai-detector"; moment: MomentType; confidence: number; at: number }
  | { source: "manual"; templateId: string; at: number };

/**
 * Exhaustiveness guard for discriminated unions.
 * Place in the default branch of every switch over a union —
 * adding a new variant becomes a compile error everywhere it's unhandled.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}
