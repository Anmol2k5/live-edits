import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  uploadMedia,
  deleteRelayMedia,
  fetchRelayInventory,
  MediaTransferError,
} from "../mediaTransfer";

describe("media transfer client (M6.1)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return handler(url, init);
      })
    );
    return calls;
  }

  const ok = (body: unknown, status = 200) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
  const err = (status: number, body: unknown) =>
    ({ ok: false, status, json: async () => body }) as Response;

  it("uploads with auth and returns the stored record", async () => {
    const calls = mockFetch(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:4190/api/media/clip.webm");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer token");
      return ok({ name: "clip.webm", bytes: 10, kind: "video" }, 201);
    });
    const file = new File([new Uint8Array(10)], "clip.webm", { type: "video/webm" });
    const result = await uploadMedia("http://127.0.0.1:4190/", "token", file, file);
    expect(result).toEqual({ name: "clip.webm", bytes: 10, kind: "video" });
    expect(calls).toHaveLength(1);
  });

  it("surfaces conflicts, rejections and auth failures typed", async () => {
    mockFetch(async () => err(409, { error: "exists" }));
    const file = new File([new Uint8Array(4)], "a.wav", { type: "audio/wav" });
    const conflict = await uploadMedia("http://x", "t", file, file).catch((e) => e);
    expect(conflict).toBeInstanceOf(MediaTransferError);
    expect((conflict as MediaTransferError).status).toBe(409);

    mockFetch(async () => err(401, { error: "unauthorized" }));
    await expect(uploadMedia("http://x", "bad", file, file)).rejects.toThrow(
      /rejected the publish token/
    );
    await expect(uploadMedia("http://x", "  ", file, file)).rejects.toThrow(
      /publish token/
    );
  });

  it("deletes and lists inventory", async () => {
    const calls = mockFetch(async (url, init) => {
      if (url.endsWith("/api/media") && (!init.method || init.method === "GET")) {
        return ok({ media: [{ name: "a.wav", bytes: 4, kind: "audio" }] });
      }
      return ok({ removed: true, name: "a.wav" });
    });
    const items = await fetchRelayInventory("http://x", "t");
    expect(items).toEqual([{ name: "a.wav", bytes: 4, kind: "audio" }]);
    await deleteRelayMedia("http://x", "t", "a.wav");
    const del = calls.find((c) => String(c.url).endsWith("/api/media/a.wav"));
    expect(del?.init.method).toBe("DELETE");
  });
});
