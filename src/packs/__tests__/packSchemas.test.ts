import { describe, it, expect } from "vitest";
import {
  createPack,
  renamePack,
  duplicatePack,
  parsePack,
  serializePack,
  importPack,
  PACK_VERSION,
} from "../packSchemas";

describe("reaction packs (M6)", () => {
  it("reserves untouched incoming IDs while rewriting collisions", () => {
    const pack = parsePack({
      ...createPack("Imported"),
      effects: [
        { id: "a", name: "First", kind: "frame", templateId: "wow-1", moment: "wow" },
        { id: "a-imported-2", name: "Second", kind: "frame", templateId: "wow-2", moment: "wow" },
      ],
      assignments: [{ id: "rule", source: "manual", effectId: "a" }],
      sequence: [{ id: "step", effectId: "a-imported-2", delayMs: 0 }],
    });
    const imported = importPack(pack, { packIds: new Set(), effectIds: new Set(["a"]) });
    expect(new Set(imported.effects.map((e) => e.id)).size).toBe(2);
    expect(imported.effects[1]?.id).toBe("a-imported-2");
    expect(imported.assignments[0]?.effectId).toBe(imported.effects[0]?.id);
    expect(imported.sequence[0]?.effectId).toBe("a-imported-2");
  });
  it("creates, renames and duplicates packs", () => {
    const pack = createPack("  My Pack  ");
    expect(pack.version).toBe(PACK_VERSION);
    expect(pack.name).toBe("My Pack");
    expect(pack.effects).toEqual([]);
    expect(() => createPack("   ")).toThrow();

    const renamed = renamePack(pack, "Renamed");
    expect(renamed.name).toBe("Renamed");
    expect(renamed.id).toBe(pack.id);
    expect(() => renamePack(pack, "  ")).toThrow();

    const copy = duplicatePack(pack);
    expect(copy.id).not.toBe(pack.id);
    expect(copy.name).toContain("copy");
  });

  it("rejects dangling references and duplicate effect ids", () => {
    const base = createPack("p");
    expect(() =>
      parsePack({
        ...base,
        assignments: [{ id: "a", source: "manual", effectId: "ghost" }],
      })
    ).toThrow(/missing effect/);
    expect(() =>
      parsePack({
        ...base,
        effects: [
          { id: "e", name: "E", kind: "frame", templateId: "wow-1", moment: "wow" },
          { id: "e", name: "E2", kind: "frame", templateId: "wow-2", moment: "wow" },
        ],
      })
    ).toThrow(/Duplicate effect ID/);
    expect(() =>
      parsePack({ ...base, version: 999 })
    ).toThrow();
  });

  it("round-trips through serialize/parse", () => {
    const pack = createPack("round");
    pack.effects.push({
      id: "vid-1",
      name: "Clip",
      kind: "video",
      mediaFile: "clip.webm",
      moment: "wow",
      durationMs: 2700,
      delayMs: 0,
      cooldownMs: 4000,
      priority: 60,
      queue: "queue",
      enabled: true,
      volume: 0.5,
      position: "center",
      entrance: "pop",
      exit: "fade",
      muted: false,
    });
    pack.assignments.push({ id: "a1", source: "manual", effectId: "vid-1" });
    pack.sequence.push({ id: "s1", effectId: "vid-1", delayMs: 500 });
    expect(parsePack(JSON.parse(serializePack(pack)))).toEqual(
      parsePack(JSON.parse(JSON.stringify(pack)))
    );
  });

  it("rewrites colliding effect ids on import", () => {
    const existing = new Set(["vid-1"]);
    const incoming = parsePack({
      ...createPack("incoming"),
      effects: [
        {
          id: "vid-1",
          name: "Clip",
          kind: "video",
          mediaFile: "clip.webm",
          moment: "wow",
        },
      ],
      assignments: [{ id: "a1", source: "manual", effectId: "vid-1" }],
      sequence: [{ id: "s1", effectId: "vid-1", delayMs: 0 }],
    });
    const imported = importPack(incoming, { packIds: new Set(), effectIds: existing });
    expect(imported.effects[0]?.id).not.toBe("vid-1");
    const newId = imported.effects[0]?.id as string;
    expect(imported.assignments[0]?.effectId).toBe(newId);
    expect(imported.sequence[0]?.effectId).toBe(newId);
  });

  it("refreshes duplicate pack ids so reimports never collide", () => {
    const first = createPack("Same");
    const once = importPack(first, { packIds: new Set(), effectIds: new Set() });
    expect(once.id).toBe(first.id);
    const twice = importPack(first, {
      packIds: new Set([first.id]),
      effectIds: new Set(),
    });
    expect(twice.id).not.toBe(first.id);
    expect(twice.name).toContain("(imported)");
    // Effects without collisions keep their ids and references intact.
    const withEffect = parsePack({
      ...createPack("WithFx"),
      effects: [
        {
          id: "stable-1",
          name: "Stable",
          kind: "video",
          mediaFile: "clip.webm",
          moment: "wow",
        },
      ],
      assignments: [{ id: "a1", source: "manual", effectId: "stable-1" }],
      sequence: [{ id: "s1", effectId: "stable-1", delayMs: 0 }],
    });
    const reimported = importPack(withEffect, {
      packIds: new Set([withEffect.id]),
      effectIds: new Set(),
    });
    expect(reimported.effects[0]?.id).toBe("stable-1");
    expect(reimported.assignments[0]?.effectId).toBe("stable-1");
    expect(reimported.sequence[0]?.effectId).toBe("stable-1");
  });
});
