import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { CloudPanel } from "../CloudPanel";
import type { PackLibrary } from "../../packs/packStore";

function emptyLibrary(): PackLibrary {
  return { version: 1, packs: [], activePackId: null };
}

describe("CloudPanel (M7)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })));
  });
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

  it("restores an HttpOnly cookie session after reload without persisting a bearer token", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      const body = path === "/api/auth/me"
        ? { user: { id: "user-1", email: "saved@example.com", displayName: "Saved" } }
        : { workspaces: [], packs: [], media: [], overlays: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    render(<CloudPanel library={emptyLibrary()} onLibraryChange={() => undefined} onLoadCloudPack={() => ({ ok: true, message: "ok" })} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy());
    expect(screen.getByText(/saved@example.com/)).toBeTruthy();
    expect(localStorage.getItem("live-edits.saas.token")).toBeNull();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/auth/me"), expect.objectContaining({ credentials: "include" }));
  });

  it("recovers a deleted saved workspace without hiding accessible workspaces", async () => {
    localStorage.setItem("live-edits.saas.workspace", "deleted-workspace");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      const body = path === "/api/auth/me" ? { user: { email: "saved@example.com" } }
        : path === "/api/workspaces" ? { workspaces: [{ id: "available", name: "Available", role: "owner", activePackUid: null }] }
        : { error: "not found" };
      return new Response(JSON.stringify(body), { status: path.includes("deleted-workspace") ? 404 : 200 });
    }));
    render(<CloudPanel library={emptyLibrary()} onLibraryChange={() => undefined} onLoadCloudPack={() => ({ ok: true, message: "ok" })} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /Available/ })).toBeTruthy());
    expect((screen.getByLabelText("Cloud workspace") as HTMLSelectElement).value).toBe("");
  });

  it("clears the active account when the backend changes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("other.example")) return new Response("{}", { status: 401 });
      const body = url.endsWith("/api/auth/me") ? { user: { email: "saved@example.com" } } : { workspaces: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    render(<CloudPanel library={emptyLibrary()} onLibraryChange={() => undefined} onLoadCloudPack={() => ({ ok: true, message: "ok" })} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Cloud backend URL"), { target: { value: "https://other.example" } });
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("ignores a delayed sign-in response after switching backends", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/api/auth/login")
      ? pending : Promise.resolve(new Response("{}", { status: 401 }))));
    render(<CloudPanel library={emptyLibrary()} onLibraryChange={() => undefined} onLoadCloudPack={() => ({ ok: true, message: "ok" })} />);
    fireEvent.change(screen.getByLabelText("Cloud email"), { target: { value: "old@example.com" } });
    fireEvent.change(screen.getByLabelText("Cloud password"), { target: { value: "correct-horse-99" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.change(screen.getByLabelText("Cloud backend URL"), { target: { value: "https://other.example" } });
    await act(async () => { finish(new Response(JSON.stringify({ token: "old-token", user: { email: "old@example.com" } }))); });
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("does not let an old sign-out clear a restored session on another backend", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/api/auth/logout")) return pending;
      const body = url.endsWith("/api/auth/me")
        ? { user: { email: url.includes("other.example") ? "new@example.com" : "old@example.com" } }
        : { workspaces: [] };
      return Promise.resolve(new Response(JSON.stringify(body)));
    }));
    render(<CloudPanel library={emptyLibrary()} onLibraryChange={() => undefined} onLoadCloudPack={() => ({ ok: true, message: "ok" })} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    fireEvent.change(screen.getByLabelText("Cloud backend URL"), { target: { value: "https://other.example" } });
    await waitFor(() => expect(screen.getByText(/new@example.com/)).toBeTruthy());
    await act(async () => { finish(new Response("{}")); });
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByText(/new@example.com/)).toBeTruthy();
  });
});
