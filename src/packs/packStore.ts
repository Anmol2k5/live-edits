import {
  parsePack,
  serializePack,
  type ReactionPack,
} from "./packSchemas";

const STORAGE_KEY = "live-edits.packs.v1";
const ACTIVE_KEY = "live-edits.active-pack.v1";

export interface PackLibrary {
  version: 1;
  packs: ReactionPack[];
  activePackId: string | null;
}

function emptyLibrary(): PackLibrary {
  return { version: 1, packs: [], activePackId: null };
}

/**
 * Local persistence layer. Stores validated pack JSON ONLY — effect configs
 * reference media by filename; blobs/object URLs live in the session media
 * registry (`src/editor/mediaLibrary.ts`) and are never written here, so a
 * 5 MB localStorage quota can never fill with video binaries.
 */
export function loadLibrary(storage: Storage = localStorage): PackLibrary {
  const raw = storage.getItem(STORAGE_KEY);
  const activeRaw = storage.getItem(ACTIVE_KEY);
  if (!raw) return { ...emptyLibrary(), activePackId: activeRaw };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { packs?: unknown }).packs)
    ) {
      throw new Error("Pack library has no packs array.");
    }
    const packs = (parsed as { packs: unknown[] }).packs.map((p) => parsePack(p));
    const activePackId =
      typeof activeRaw === "string" && packs.some((p) => p.id === activeRaw)
        ? activeRaw
        : null;
    return { version: 1, packs, activePackId };
  } catch {
    // Corrupt or foreign data: start clean rather than crash the editor.
    // The raw value is left untouched so nothing is silently destroyed.
    return { ...emptyLibrary(), activePackId: null };
  }
}

export function saveLibrary(
  library: PackLibrary,
  storage: Storage = localStorage
): void {
  const packs = library.packs.map((p) => parsePack(p));
  const activePackId =
    library.activePackId !== null &&
    packs.some((p) => p.id === library.activePackId)
      ? library.activePackId
      : null;
  // Serialize-then-store keeps one bad pack from wiping the rest: parsePack
  // throws before anything is written.
  const body = JSON.stringify({
    version: 1 as const,
    packs: packs.map((p) => JSON.parse(serializePack(p))),
  });
  storage.setItem(STORAGE_KEY, body);
  if (activePackId === null) {
    storage.removeItem(ACTIVE_KEY);
  } else {
    storage.setItem(ACTIVE_KEY, activePackId);
  }
}

export function getActivePack(library: PackLibrary): ReactionPack | null {
  return (
    library.packs.find((p) => p.id === library.activePackId) ?? null
  );
}
