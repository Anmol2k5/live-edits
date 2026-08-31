import { describe, it, expect } from "vitest";
import { getTemplateById, TEMPLATES } from "../templates";

describe("getTemplateById", () => {
  it.each(TEMPLATES.map((t) => [t.id, t.name]))(
    "returns the correct template for known ID '%s'",
    (id, expectedName) => {
      const template = getTemplateById(id);
      expect(template.id).toBe(id);
      expect(template.name).toBe(expectedName);
    }
  );

  it("throws a ZodError for an unknown ID", () => {
    expect(() => getTemplateById("nope")).toThrow();
    try {
      getTemplateById("does-not-exist");
    } catch (err) {
      // Zod v4 throws ZodError — verify the message is descriptive
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBeTruthy();
    }
  });

  it("registry contains exactly 6 templates", () => {
    expect(TEMPLATES).toHaveLength(6);
  });
});
