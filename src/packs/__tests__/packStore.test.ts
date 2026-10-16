import { describe, it, expect, beforeEach } from "vitest";
import { createPack } from "../packSchemas";
import { loadLibrary, saveLibrary, getActivePack } from "../packStore";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe("pack persistence (M6)", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = memoryStorage();
  });

  it("saves and reloads packs with the active selection", () => {
    const a = createPack("A");
    const b = createPack("B");
    saveLibrary({ version: 1, packs: [a, b], activePackId: b.id }, storage);
    const loaded = loadLibrary(storage);
    expect(loaded.packs.map((p) => p.name)).toEqual(["A", "B"]);
    expect(getActivePack(loaded)?.id).toBe(b.id);
  });

  it("never stores binaries or object urls", () => {
    const pack = createPack("media");
    pack.effects.push({
      id: "v1",
      name: "Clip",
      kind: "video",
      mediaFile: "clip.webm",
      moment: "wow",
      durationMs: 2700,
      delayMs: 0,
      cooldownMs: 4000,
      priority: 50,
      queue: "replace",
      enabled: true,
      volume: 1,
      position: "center",
      entrance: "pop",
      exit: "fade",
      muted: false,
    });
    saveLibrary({ version: 1, packs: [pack], activePackId: pack.id }, storage);
    const raw = storage.getItem("live-edits.packs.v1") as string;
    expect(raw).not.toContain("blob:");
    expect(raw).not.toContain("data:video");
    expect(raw.length).toBeLessThan(64 * 1024);
  });

  it("starts clean on corrupt data without destroying it", () => {
    storage.setItem("live-edits.packs.v1", "{not json");
    const loaded = loadLibrary(storage);
    expect(loaded.packs).toEqual([]);
    expect(loaded.activePackId).toBeNull();
    // Untouched so a future migration could still recover it.
    expect(storage.getItem("live-edits.packs.v1")).toBe("{not json");
  });

  it("drops unknown active ids and validates on save", () => {
    const pack = createPack("A");
    saveLibrary({ version: 1, packs: [pack], activePackId: "ghost" }, storage);
    expect(loadLibrary(storage).activePackId).toBeNull();
    expect(() =>
      saveLibrary(
        {
          version: 1,
          packs: [
            {
              ...pack,
              assignments: [{ id: "a", source: "manual", effectId: "ghost" }],
            },
          ],
          activePackId: null,
        },
        storage
      )
    ).toThrow(/missing effect/);
  });
});
