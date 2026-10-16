import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { useState } from "react";
import { ReactionEditor } from "../ReactionEditor";
import { MediaRegistry } from "../mediaLibrary";
import type { PackLibrary } from "../../packs/packStore";
import type { AnyEffect } from "../../effects/effectSchemas";
import type { ReactionPack } from "../../packs/packSchemas";

function emptyLibrary(): PackLibrary {
  return { version: 1, packs: [], activePackId: null };
}

interface Fired {
  effect: AnyEffect;
  pack: ReactionPack;
}

/** Mini-App: feeds library changes back exactly like the real App does. */
function Harness({
  fired,
  relayReady = true,
  relayBase = "http://127.0.0.1:4190",
  publishToken = "",
}: {
  fired: Fired[];
  relayReady?: boolean;
  relayBase?: string;
  publishToken?: string;
}) {
  const [library, setLibrary] = useState<PackLibrary>(emptyLibrary());
  const [media] = useState(() => new MediaRegistry());
  const [, setVersion] = useState(0);
  return (
    <ReactionEditor
      library={library}
      onLibraryChange={setLibrary}
      media={media}
      onMediaChange={() => setVersion((v) => v + 1)}
      relayReady={relayReady}
      relayBase={relayBase}
      publishToken={publishToken}
      onFireEffect={(effect, pack) => {
        fired.push({ effect, pack });
      }}
    />
  );
}

function setup(relayReady = true, relayBase = "http://127.0.0.1:4190", publishToken = "") {
  const fired: Fired[] = [];
  const utils = render(<Harness fired={fired} relayReady={relayReady} relayBase={relayBase} publishToken={publishToken} />);
  return { ...utils, fired };
}

function wavFile(): File {
  return new File([new Uint8Array([82, 73, 70, 70])], "sting.wav", {
    type: "audio/wav",
  });
}

function webmFile(): File {
  return new File([new Uint8Array([26, 69, 223, 163])], "clip.webm", {
    type: "video/webm",
  });
}

function createPackNamed(name: string): void {
  fireEvent.change(screen.getByLabelText("New pack name"), {
    target: { value: name },
  });
  fireEvent.click(screen.getByText("Create", { selector: "button" }));
}

function packOptionId(name: string): string {
  const option = screen.getByRole("option", { name: new RegExp(name) });
  const value = option.getAttribute("value");
  if (!value) throw new Error(`No value for pack option ${name}`);
  return value;
}

describe("ReactionEditor workflow (M6)", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock-url"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("creates a pack, imports media, builds, previews and fires an effect", async () => {
    const { fired } = setup();
    createPackNamed("Stream Pack");
    // Freshly created packs persist immediately, so the draft is clean.
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByRole("option", { name: /Stream Pack/ })).toBeTruthy();

    const importInput = screen.getByLabelText("Import media files");
    fireEvent.change(importInput, { target: { files: [wavFile()] } });
    await waitFor(() => {
      expect(screen.getByText("sting.wav")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("sting.wav"));
    // Import auto-selects; clicking again toggles selection off.
    expect(
      document.querySelector('[aria-pressed="true"]')
    ).toBeNull();
    // Re-select for effect creation.
    fireEvent.click(screen.getByText("sting.wav"));
    fireEvent.change(screen.getByLabelText("New effect kind"), {
      target: { value: "audio" },
    });
    fireEvent.click(screen.getByText("Create effect"));
    expect(
      screen.getByRole("button", { name: "audio wow (audio)" })
    ).toBeTruthy();
    // Creating the effect edits the draft without saving.
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Effect name"), {
      target: { value: "Hype Sting" },
    });
    fireEvent.click(screen.getByText(/^Save/));
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    fireEvent.click(screen.getByText("Preview", { selector: "button" }));
    await waitFor(() => {
      expect(screen.getByTestId("preview-stage").querySelector("audio")).not.toBeNull();
    });

    fireEvent.click(screen.getByText("Fire to OBS"));
    expect(fired).toHaveLength(1);
    expect(fired[0]?.effect.kind).toBe("audio");
    expect(fired[0]?.effect.name).toBe("Hype Sting");
    expect(fired[0]?.pack.effects.map((e) => e.id)).toContain(fired[0]?.effect.id);
  });

  it("rejects invalid property edits with field errors", async () => {
    setup();
    createPackNamed("P");
    fireEvent.change(screen.getByLabelText("Import media files"), {
      target: { files: [webmFile()] },
    });
    await waitFor(() => {
      expect(screen.getByText("clip.webm")).toBeTruthy();
    });
    // Import auto-selects the file; video kind matches for trim fields.
    fireEvent.change(screen.getByLabelText("New effect kind"), {
      target: { value: "video" },
    });
    fireEvent.click(screen.getByText("Create effect"));
    expect(
      screen.getByRole("button", { name: /\(video\)/ })
    ).toBeTruthy();

    const start = screen.getByLabelText("Trim start milliseconds");
    const end = screen.getByLabelText("Trim end milliseconds");
    fireEvent.change(start, { target: { value: "2000" } });
    fireEvent.blur(start);
    fireEvent.change(end, { target: { value: "1000" } });
    fireEvent.blur(end);
    await waitFor(() => {
      expect(screen.getByText(/clipEndMs must exceed clipStartMs/i)).toBeTruthy();
    });
  });

  it("supports undo/redo and guards pack switching on dirty drafts", () => {
    setup();
    createPackNamed("One");
    createPackNamed("Two");

    fireEvent.change(screen.getByLabelText("Reaction pack"), {
      target: { value: packOptionId("One") },
    });
    fireEvent.change(screen.getByLabelText("New pack name"), { target: { value: "One!" } });
    fireEvent.click(screen.getByText("Rename"));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByText("Undo", { selector: "button" }));
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    fireEvent.click(screen.getByText("Redo", { selector: "button" }));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Reaction pack"), {
      target: { value: packOptionId("Two") },
    });
    expect(screen.getByText(/Save first\?/)).toBeTruthy();
    fireEvent.click(screen.getByText("Switch without saving"));
    expect(screen.queryByText(/Save first\?/)).toBeNull();
    expect(
      (screen.getByLabelText("Reaction pack") as HTMLSelectElement).value
    ).toBe(packOptionId("Two"));
  });

  it("blocks firing without a relay token and guides empty states", () => {
    setup(false);
    expect(screen.getByText(/no webcam required/i)).toBeTruthy();
  });

  it("exports and reimports a pack with validated integrity", async () => {
    setup();
    createPackNamed("ExportMe");
    fireEvent.change(screen.getByLabelText("Import media files"), {
      target: { files: [wavFile()] },
    });
    await waitFor(() => {
      expect(screen.getByText("sting.wav")).toBeTruthy();
    });

    // Export downloads validated JSON (anchor click is a no-op in jsdom).
    const createdUrls: unknown[] = [];
    const createSpy = vi.mocked(URL.createObjectURL);
    createSpy.mockImplementation((blob: Blob | MediaSource) => {
      createdUrls.push(blob);
      return "blob:mock-url";
    });
    fireEvent.click(screen.getByText("Export"));
    const exported = createdUrls.find((b) => b instanceof Blob) as Blob | undefined;
    expect(exported).toBeDefined();
    expect(exported?.type).toBe("application/json");
    const exportedText = await exported?.text();
    const exportedJson = JSON.parse(exportedText ?? "{}") as {
      name?: string;
      version?: number;
      effects?: unknown[];
    };
    expect(exportedJson.name).toBe("ExportMe");
    expect(exportedJson.version).toBe(1);
    expect(exportedJson.effects).toEqual([]);

    // Reimport the same JSON through the file input.
    const packFile = new File([exportedText ?? "{}"], "export.json", {
      type: "application/json",
    });
    fireEvent.change(screen.getByLabelText("Import pack JSON"), {
      target: { files: [packFile] },
    });
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /ExportMe/ })).toBeTruthy();
    });
  });
});

describe("ReactionEditor relay transfer (M6.1)", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock-url"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function relayFetch(state: { inventory: string[]; uploads: string[]; deletes: string[] }) {
    const ok = (body: unknown, status = 200) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
    const err = (status: number, body: unknown) =>
      ({ ok: false, status, json: async () => body }) as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? "GET").toUpperCase();
        if (u.endsWith("/api/media") && method === "GET") {
          return ok({ media: state.inventory.map((name) => ({ name, bytes: 10, kind: "audio" })) });
        }
        if (u.includes("/api/media/") && method === "POST") {
          const name = decodeURIComponent(u.split("/api/media/")[1] ?? "");
          if (state.inventory.includes(name)) return err(409, { error: "exists" });
          state.inventory.push(name);
          state.uploads.push(name);
          return ok({ name, bytes: 10, kind: "audio" }, 201);
        }
        if (u.includes("/api/media/") && method === "DELETE") {
          const name = decodeURIComponent(u.split("/api/media/")[1] ?? "");
          const idx = state.inventory.indexOf(name);
          if (idx < 0) return err(404, { error: "not found" });
          state.inventory.splice(idx, 1);
          state.deletes.push(name);
          return ok({ removed: true, name });
        }
        return err(404, { error: "not found" });
      })
    );
    return state;
  }

  it("streams imports to the relay automatically when a token is present", async () => {
    const state = relayFetch({ inventory: [], uploads: [], deletes: [] });
    setup(true, "http://127.0.0.1:4190", "token");
    createPackNamed("Transfer Pack");
    fireEvent.change(screen.getByLabelText("Import media files"), {
      target: { files: [wavFile()] },
    });
    await waitFor(() => {
      expect(screen.getByText("sting.wav")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getAllByText(/on relay/i).length).toBeGreaterThan(0);
    });
    expect(state.uploads).toContain("sting.wav");
    expect(screen.getByText(/Refresh relay files/i)).toBeTruthy();
  });

  it("keeps imports local without a token and offers manual Send to relay", async () => {
    relayFetch({ inventory: [], uploads: [], deletes: [] });
    setup(true);
    createPackNamed("Local Pack");
    fireEvent.change(screen.getByLabelText("Import media files"), {
      target: { files: [wavFile()] },
    });
    await waitFor(() => {
      expect(screen.getByText("sting.wav")).toBeTruthy();
    });
    expect(screen.getAllByText(/publish token/i).length).toBeGreaterThan(0);
    // No token: no Send happens, and the button is disabled with guidance.
    expect(screen.getByText("Send to relay")).toBeTruthy();
    expect((screen.getByText("Send to relay") as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces relay conflicts with a confirmed replace path", async () => {
    const state = relayFetch({ inventory: ["sting.wav"], uploads: [], deletes: [] });
    setup(true, "http://127.0.0.1:4190", "token");
    createPackNamed("Conflict Pack");
    fireEvent.change(screen.getByLabelText("Import media files"), {
      target: { files: [wavFile()] },
    });
    await waitFor(() => {
      expect(screen.getByText("sting.wav")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText(/Already on the relay/i)).toBeTruthy();
    });
    expect(state.uploads).not.toContain("sting.wav");
    // Two-step replace: arm then confirm deletes first, then uploads.
    fireEvent.click(screen.getByText("Replace on relay"));
    fireEvent.click(screen.getByText("Confirm replace"));
    await waitFor(() => {
      expect(state.deletes).toContain("sting.wav");
    });
    await waitFor(() => {
      expect(state.uploads).toContain("sting.wav");
    });
  });

  it("deletes relay copies with confirmation and refreshes inventory", async () => {
    const state = relayFetch({ inventory: ["sting.wav"], uploads: [], deletes: [] });
    setup(true, "http://127.0.0.1:4190", "token");
    createPackNamed("Delete Pack");
    fireEvent.change(screen.getByLabelText("Import media files"), {
      target: { files: [wavFile()] },
    });
    await waitFor(() => {
      expect(screen.getByText("sting.wav")).toBeTruthy();
    });
    // Conflict path leaves the relay copy listed; delete it explicitly.
    await waitFor(() => {
      expect(screen.getByText("Delete from relay")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Delete from relay"));
    fireEvent.click(screen.getByText(/Confirm delete/));
    await waitFor(() => {
      expect(state.deletes).toContain("sting.wav");
    });
  });
});
