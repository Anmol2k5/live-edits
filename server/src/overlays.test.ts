// @vitest-environment node
import { describe, it, expect } from "vitest";
import { api, register, createWorkspace, samplePack, wavBytes, startTestApp } from "./test-helpers.ts";

async function upload(base: string, token: string, ws: string, name: string, body: Buffer): Promise<number> {
  const response = await fetch(`${base}/api/workspaces/${ws}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "audio/wav", "X-Filename": encodeURIComponent(name) },
    body: new Uint8Array(body),
  });
  await response.arrayBuffer().catch(() => undefined);
  return response.status;
}

describe("saas overlays and triggers (M7)", () => {
  it("creates overlay sessions, delivers triggers, and isolates workspaces", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "oa@example.com");
      const b = await register(app.base, "ob@example.com");
      const wsA = await createWorkspace(app.base, a.token, "WA");
      const wsB = await createWorkspace(app.base, b.token, "WB");
      await api(app.base, "POST", `/api/workspaces/${wsA}/packs`, a.token, samplePack());
      await api(app.base, "POST", `/api/workspaces/${wsA}/activate`, a.token, { packUid: "pack-1" });
      expect(await upload(app.base, a.token, wsA, "clip.wav", wavBytes(2000))).toBe(201);

      const mkA = await api(app.base, "POST", `/api/workspaces/${wsA}/overlays`, a.token, { name: "OBS Main" });
      expect(mkA.status).toBe(201);
      const { overlay, viewToken } = mkA.json as { overlay: { id: string }; viewToken: string };

      const mkB = await api(app.base, "POST", `/api/workspaces/${wsB}/overlays`, b.token, { name: "Other" });
      const other = mkB.json as { overlay: { id: string }; viewToken: string };

      // Two simultaneous overlays on A both connect.
      const ea = await fetch(`${app.base}/o/${overlay.id}/events?token=${viewToken}`);
      expect(ea.status).toBe(200);
      const ra = ea.body?.getReader();
      await ra?.read();
      const eb = await fetch(`${app.base}/o/${overlay.id}/events?token=${viewToken}`);
      expect(eb.status).toBe(200);
      const rb = eb.body?.getReader();
      await rb?.read();
      const eo = await fetch(`${app.base}/o/${other.overlay.id}/events?token=${other.viewToken}`);
      expect(eo.status).toBe(200);
      const ro = eo.body?.getReader();
      await ro?.read();

      const fire = await api(app.base, "POST", `/api/workspaces/${wsA}/trigger`, a.token, { moment: "wow", effectId: "clip-1" });
      expect(fire.status).toBe(202);
      expect((fire.json as { accepted: boolean }).accepted).toBe(true);

      const decode = async (reader: ReadableStreamDefaultReader<Uint8Array> | undefined): Promise<string> => {
        if (!reader) return "";
        const { value } = await reader.read();
        return new TextDecoder().decode(value);
      };
      const chunkA = await decode(ra);
      const chunkB = await decode(rb);
      expect(chunkA).toMatch(/event: reaction/);
      expect(chunkA).toMatch(/clip\.wav/);
      expect(chunkB).toMatch(/event: reaction/);
      // Other workspace receives nothing (with a short timeout, no reaction frame arrives).
      const raced = await Promise.race([
        decode(ro).then((c) => c),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500)),
      ]);
      expect(raced).not.toMatch(/event: reaction/);

      await ra?.cancel().catch(() => undefined);
      await rb?.cancel().catch(() => undefined);
      await ro?.cancel().catch(() => undefined);

      // History + audit recorded.
      const hist = await api(app.base, "GET", `/api/workspaces/${wsA}/triggers`, a.token);
      expect((hist.json as { triggers: unknown[] }).triggers.length).toBeGreaterThan(0);
      const audit = await api(app.base, "GET", `/api/workspaces/${wsA}/audit`, a.token);
      expect((audit.json as { audit: unknown[] }).audit.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("revokes and rotates sessions; revoked tokens are rejected everywhere", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "rev@example.com");
      const ws = await createWorkspace(app.base, a.token, "Rev");
      const mk = await api(app.base, "POST", `/api/workspaces/${ws}/overlays`, a.token, { name: "Main" });
      const { overlay, viewToken } = mk.json as { overlay: { id: string }; viewToken: string };

      expect((await fetch(`${app.base}/o/${overlay.id}?token=${viewToken}`).then(async (r) => {
        await r.arrayBuffer().catch(() => undefined);
        return r.status;
      }))).toBe(200);

      const rot = await api(app.base, "POST", `/api/workspaces/${ws}/overlays/${overlay.id}/rotate`, a.token);
      expect(rot.status).toBe(200);
      const fresh = (rot.json as { viewToken: string }).viewToken;
      expect(fresh).not.toBe(viewToken);
      expect((await fetch(`${app.base}/o/${overlay.id}/events?token=${viewToken}`).then((r) => r.status))).toBe(403);
      const ev2 = await fetch(`${app.base}/o/${overlay.id}/events?token=${fresh}`);
      expect(ev2.status).toBe(200);
      await ev2.body?.getReader().read().catch(() => undefined);
      await ev2.body?.cancel().catch(() => undefined);

      const rev = await api(app.base, "POST", `/api/workspaces/${ws}/overlays/${overlay.id}/revoke`, a.token);
      expect(rev.status).toBe(200);
      expect((await fetch(`${app.base}/o/${overlay.id}?token=${fresh}`).then((r) => r.status))).toBe(403);
      expect((await fetch(`${app.base}/o/${overlay.id}/events?token=${fresh}`).then((r) => r.status))).toBe(403);
      const again = await api(app.base, "POST", `/api/workspaces/${ws}/overlays/${overlay.id}/rotate`, a.token);
      expect(again.status).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("expires triggers, deduplicates repeats, and rejects bad payloads/media", async () => {    const app = await startTestApp();
    try {
      const a = await register(app.base, "t7@example.com");
      const ws = await createWorkspace(app.base, a.token, "Trig");
      await api(app.base, "POST", `/api/workspaces/${ws}/packs`, a.token, samplePack());
      await api(app.base, "POST", `/api/workspaces/${ws}/activate`, a.token, { packUid: "pack-1" });
      await upload(app.base, a.token, ws, "clip.wav", wavBytes(500));

      const expired = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", expiresAt: Date.now() - 1000 });
      expect(expired.status).toBe(400);

      const first = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", effectId: "clip-1", triggerId: "dup-1" });
      expect(first.status).toBe(202);
      const repeat = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", effectId: "clip-1", triggerId: "dup-1" });
      expect(repeat.status).toBe(202);
      expect((repeat.json as { duplicate: boolean }).duplicate).toBe(true);

      const ghost = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", mediaFile: "ghost.wav" });
      expect(ghost.status).toBe(400);
      const unknown = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", effectId: "effect-nope" });
      expect(unknown.status).toBe(400);
      const mismatch = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", templateId: "sad-1" });
      expect(mismatch.status).toBe(400);

      // Unauthorized trigger attempts cannot touch the workspace.
      const b = await register(app.base, "t7b@example.com");
      expect((await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, b.token, { moment: "wow" })).status).toBe(404);
      expect((await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, undefined, { moment: "wow" })).status).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("saas overlay reliability (M7.1)", () => {
  it("resolves assigned effects to their full playback configuration", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "full@example.com");
      const ws = await createWorkspace(app.base, a.token, "Full");
      await api(app.base, "POST", `/api/workspaces/${ws}/packs`, a.token, samplePack());
      await api(app.base, "POST", `/api/workspaces/${ws}/activate`, a.token, { packUid: "pack-1" });
      expect(await upload(app.base, a.token, ws, "clip.wav", wavBytes(2000))).toBe(201);
      const mk = await api(app.base, "POST", `/api/workspaces/${ws}/overlays`, a.token, { name: "Main" });
      const { overlay, viewToken } = mk.json as { overlay: { id: string }; viewToken: string };

      const events = await fetch(`${app.base}/o/${overlay.id}/events?token=${viewToken}`);
      expect(events.status).toBe(200);
      const reader = events.body?.getReader();
      await reader?.read();

      // Template trigger with NO effectId: the manual/wow assignment must
      // supply media, duration, volume, trim, position — not just policy.
      const fire = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow", templateId: "wow-1" });
      expect(fire.status).toBe(202);
      let text = "";
      const deadline = Date.now() + 10000;
      while (!/event: reaction/.test(text) && Date.now() < deadline) {
        const { value } = (await reader?.read()) as { value?: Uint8Array };
        text += new TextDecoder().decode(value);
      }
      expect(text).toMatch(/"mediaFile":"clip\.wav"/);
      expect(text).toMatch(/"durationMs":3200/);
      expect(text).toMatch(/"volume":0\.4/);
      expect(text).toMatch(/"position":"fullscreen"/);
      expect(text).toMatch(/"clipStartMs":200/);
      expect(text).toMatch(/"clipEndMs":2200/);
      expect(text).toMatch(/"effectId":"clip-1"/);
      await reader?.cancel().catch(() => undefined);
    } finally {
      await app.close();
    }
  });

  it("serves hosted media ranges and bundled template art", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "range@example.com");
      const ws = await createWorkspace(app.base, a.token, "Range");
      await upload(app.base, a.token, ws, "clip.wav", wavBytes(2000));
      const mk = await api(app.base, "POST", `/api/workspaces/${ws}/overlays`, a.token, { name: "Main" });
      const { overlay, viewToken } = mk.json as { overlay: { id: string }; viewToken: string };
      const total = wavBytes(2000).length;

      const full = await fetch(`${app.base}/o/${overlay.id}/media/clip.wav?token=${viewToken}`);
      expect(full.status).toBe(200);
      expect(full.headers.get("accept-ranges")).toBe("bytes");
      expect(Number(full.headers.get("content-length"))).toBe(total);
      await full.arrayBuffer();

      const slice = await fetch(`${app.base}/o/${overlay.id}/media/clip.wav?token=${viewToken}`, { headers: { Range: "bytes=0-9" } });
      expect(slice.status).toBe(206);
      expect(slice.headers.get("content-range")).toBe(`bytes 0-9/${total}`);
      expect((await slice.arrayBuffer()).byteLength).toBe(10);

      const pastEnd = await fetch(`${app.base}/o/${overlay.id}/media/clip.wav?token=${viewToken}`, { headers: { Range: `bytes=${total + 100}-${total + 200}` } });
      expect(pastEnd.status).toBe(416);
      await pastEnd.arrayBuffer().catch(() => undefined);

      const art = await fetch(`${app.base}/o/${overlay.id}/templates/wow-1.png`);
      expect(art.status).toBe(200);
      expect(art.headers.get("content-type")).toBe("image/png");
      expect((await art.arrayBuffer()).byteLength).toBeGreaterThan(100);
      const missing = await fetch(`${app.base}/o/${overlay.id}/templates/nope.png`);
      expect(missing.status).toBe(404);
      await missing.arrayBuffer().catch(() => undefined);
    } finally {
      await app.close();
    }
  });

  it("drops live clients on revoke and rejects everything after", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "mid@example.com");
      const ws = await createWorkspace(app.base, a.token, "Mid");
      const mk = await api(app.base, "POST", `/api/workspaces/${ws}/overlays`, a.token, { name: "Main" });
      const { overlay, viewToken } = mk.json as { overlay: { id: string }; viewToken: string };
      const events = await fetch(`${app.base}/o/${overlay.id}/events?token=${viewToken}`);
      expect(events.status).toBe(200);
      const reader = events.body?.getReader();
      await reader?.read();

      await api(app.base, "POST", `/api/workspaces/${ws}/overlays/${overlay.id}/revoke`, a.token);
      // The live stream ends promptly after revocation.
      const deadline = Date.now() + 5000;
      let done = false;
      while (!done && Date.now() < deadline) {
        const next = await reader?.read();
        done = next?.done === true;
      }
      expect(done).toBe(true);

      const fire = await api(app.base, "POST", `/api/workspaces/${ws}/trigger`, a.token, { moment: "wow" });
      expect(fire.status).toBe(202);
      expect((fire.json as { connectedOverlays: number }).connectedOverlays).toBe(0);
      expect((await fetch(`${app.base}/o/${overlay.id}/events?token=${viewToken}`).then((r) => r.status))).toBe(403);
      expect((await fetch(`${app.base}/o/${overlay.id}/media/clip.wav?token=${viewToken}`).then((r) => r.status))).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("keeps concurrent workspaces strictly ordered and isolated under burst load", async () => {
    const app = await startTestApp();
    try {
      const a = await register(app.base, "burst-a@example.com");
      const b = await register(app.base, "burst-b@example.com");
      const wsA = await createWorkspace(app.base, a.token, "BA");
      const wsB = await createWorkspace(app.base, b.token, "BB");
      const mkA = (await api(app.base, "POST", `/api/workspaces/${wsA}/overlays`, a.token, { name: "A" })).json as { overlay: { id: string }; viewToken: string };
      const mkB = (await api(app.base, "POST", `/api/workspaces/${wsB}/overlays`, b.token, { name: "B" })).json as { overlay: { id: string }; viewToken: string };

      async function collect(base: string, oid: string, token: string, count: number): Promise<number[]> {
        const events = await fetch(`${base}/o/${oid}/events?token=${token}`);
        const reader = events.body?.getReader();
        await reader?.read();
        const seqs: number[] = [];
        const text: string[] = [];
        const deadline = Date.now() + 20000;
        while (seqs.length < count && Date.now() < deadline) {
          const { value, done } = (await reader?.read()) as { value?: Uint8Array; done: boolean };
          if (done) break;
          text.push(new TextDecoder().decode(value));
          const joined = text.join("");
          const found = [...joined.matchAll(/"sequence":(\d+)/g)].map((m) => Number(m[1]));
          seqs.length = 0;
          seqs.push(...found);
        }
        await reader?.cancel().catch(() => undefined);
        return seqs;
      }

      const collectingA = collect(app.base, mkA.overlay.id, mkA.viewToken, 20);
      const collectingB = collect(app.base, mkB.overlay.id, mkB.viewToken, 20);
      await new Promise((r) => setTimeout(r, 300));
      for (let i = 0; i < 20; i += 1) {
        const [fa, fb] = await Promise.all([
          api(app.base, "POST", `/api/workspaces/${wsA}/trigger`, a.token, { moment: "wow", triggerId: `a-${i}` }),
          api(app.base, "POST", `/api/workspaces/${wsB}/trigger`, b.token, { moment: "sad", templateId: "sad-1", triggerId: `b-${i}` }),
        ]);
        expect(fa.status).toBe(202);
        expect(fb.status).toBe(202);
      }
      const [seqA, seqB] = await Promise.all([collectingA, collectingB]);
      expect(seqA).toHaveLength(20);
      expect(seqB).toHaveLength(20);
      expect([...seqA].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect([...seqB].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    } finally {
      await app.close();
    }
  });
});
