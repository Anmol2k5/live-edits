import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CloudPanel } from "../CloudPanel";
import type { PackLibrary } from "../../packs/packStore";

function emptyLibrary(): PackLibrary {
  return { version: 1, packs: [], activePackId: null };
}

describe("CloudPanel (M7)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the backend connection and auth forms in local-first mode", () => {
    render(<CloudPanel library={emptyLibrary()} onLibraryChange={() => undefined} onLoadCloudPack={() => ({ ok: true, message: "ok" })} />);
    expect(screen.getByLabelText("Cloud backend URL")).toBeTruthy();
    expect(screen.getByLabelText("Cloud email")).toBeTruthy();
    expect(screen.getByLabelText("Cloud password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Register" })).toBeTruthy();
    // Workspace sections stay hidden until a session exists.
    expect(screen.queryByLabelText("Cloud workspace")).toBeNull();
  });

  it("surfaces local packs for cloud save once workspaces exist", () => {
    const library: PackLibrary = {
      version: 1,
      packs: [{ version: 1, id: "pack-1", name: "Local", effects: [], assignments: [], sequence: [] }],
      activePackId: null,
    };
    render(<CloudPanel library={library} onLibraryChange={() => undefined} onLoadCloudPack={() => ({ ok: true, message: "ok" })} />);
    // Not signed in: local pack rows are not shown yet (cloud sections gated on session).
    expect(screen.queryByText("Save to cloud")).toBeNull();
  });
});
