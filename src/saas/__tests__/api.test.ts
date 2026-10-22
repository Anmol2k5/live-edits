import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthMode, loadSaasBase, saasApi } from "../api";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("cloud authentication transport", () => {
  it("recognizes Tauri's runtime flag without the optional __TAURI__ global", () => {
    vi.stubGlobal("isTauri", true);
    expect(getAuthMode()).toBe("desktop");
  });

  it("keeps the default local backend on the dashboard's cookie site", () => {
    expect(new URL(loadSaasBase()).hostname).toBe(window.location.hostname);
  });

  it("uses cookies and CSRF for web writes without exposing a bearer token", async () => {
    document.cookie = "le_csrf=csrf-value; path=/";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await saasApi.createWorkspace("http://localhost:4290", "cookie-session", "My workspace");
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(options.credentials).toBe("include");
    expect(options.headers).toEqual({ "Content-Type": "application/json", "X-CSRF-Token": "csrf-value" });
    document.cookie = "le_csrf=; Max-Age=0; path=/";
  });
});
