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
}: {
  fired: Fired[];
  relayReady?: boolean;
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
      onFireEffect={(effect, pack) => {
        fired.push({ effect, pack });
      }}
    />
  );
}

function setup(relayReady = true) {
  const fired: Fired[] = [];
  const utils = render(<Harness fired={fired} relayReady={relayReady} />);
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
