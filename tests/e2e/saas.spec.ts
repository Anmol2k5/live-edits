import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeWav } from "./helpers";
import { startSaasBackend, type SaasBackend } from "./helpers-saas";

let browser: Browser;
let backend: SaasBackend;
let wavPath: string;

test.setTimeout(120000);

test.beforeAll(async () => {
  browser = await chromium.launch({
    channel: "chrome",
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--disable-dev-shm-usage"],
  });
  const sourceDir = mkdtempSync(join(tmpdir(), "saas-e2e-src-"));
  wavPath = join(sourceDir, "sting.wav");
  makeWav(wavPath);
  backend = await startSaasBackend();
});

test.afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await backend?.stop().catch(() => undefined);
});

async function overlayConnected(base: string, overlayUrl: string, page: Page): Promise<void> {
  await page.goto(overlayUrl);
  await expect(page.locator("#stage")).toBeAttached();
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const health = (await (await fetch(`${base}/api/health`)).json()) as { connectedOverlays?: number };
      if ((health.connectedOverlays ?? 0) >= 1) break;
    } catch {
      // starting
    }
    if (Date.now() > deadline) throw new Error("hosted overlay did not connect");
    await page.waitForTimeout(250);
  }
}

/**
 * M7 vertical slice in a real browser against the real backend (no mocks):
 * sign in → workspace → pack → media upload → configure effect → save →
 * overlay session → trigger → correct overlay receives → other workspace
 * isolated → revoke stops delivery → reload keeps packs across sessions.
 */
test("hosted account → pack → media → overlay slice with tenant isolation", async () => {
  const app = await browser.newPage();
  try {
    await app.goto("http://localhost:1420/", { waitUntil: "networkidle" });
    // Desktop-companion auth path (Bearer): the dashboard and the ephemeral
    // test backend are cross-origin, so HttpOnly cookies cannot flow here.
    // The cookie + CSRF web path is covered by server unit tests instead.
    await app.evaluate(() => localStorage.setItem("live-edits.saas.auth-mode", "desktop"));
    await app.getByRole("button", { name: "Cloud", exact: true }).click();
    await app.getByLabel("Cloud backend URL").fill(backend.base);

    // Sign in (register path).
    await app.getByLabel("Cloud email").fill("cloud-a@example.com");
    await app.getByLabel("Cloud password").fill("correct-horse-99");
    await app.getByRole("button", { name: "Register", exact: true }).click();
    await expect(app.getByText("Registered and signed in.")).toBeAttached({ timeout: 15000 });

    // Workspace.
    await app.getByLabel("New workspace name").fill("Stream Team");
    await app.getByRole("button", { name: "Create workspace" }).click();
    await expect(app.getByRole("option", { name: /Stream Team/ })).toBeAttached({ timeout: 15000 });

    // Reaction pack (empty shell created in the cloud; configured below).
    await app.getByLabel("New cloud pack name").fill("Cloud Pack");
    await app.getByRole("button", { name: "Create cloud pack" }).click();
    await expect(app.getByText("Cloud Pack").first()).toBeAttached({ timeout: 15000 });

    // Media upload to private workspace storage (no manual copying).
    await app.getByLabel("Upload cloud media files").setInputFiles(wavPath);
    await expect(app.getByText("sting.wav").first()).toBeAttached({ timeout: 15000 });

    // Configure the effect: same validated shape the visual editor emits.
    // Resolve ids via the UI session: reuse the browser token from localStorage.
    const session = await app.evaluate(() => localStorage.getItem("live-edits.saas.token"));
    const workspaces = (await (await fetch(`${backend.base}/api/workspaces`, {
      headers: { Authorization: `Bearer ${session}` },
    })).json()) as { workspaces: Array<{ id: string }> };
    const workspaceId = workspaces.workspaces[0]?.id ?? "";
    expect(workspaceId).toBeTruthy();
    const existingPacks = (await (await fetch(`${backend.base}/api/workspaces/${workspaceId}/packs`, {
      headers: { Authorization: `Bearer ${session}` },
    })).json()) as { packs: Array<{ packUid: string }> };
    const packUid = existingPacks.packs[0]?.packUid ?? "";
    expect(packUid).toBeTruthy();
    const packBody = {
      version: 1,
      id: packUid,
      name: "Cloud Pack",
      effects: [
        {
          id: "clip-1", name: "Clip", kind: "video", mediaFile: "sting.wav", moment: "wow",
          durationMs: 3200, delayMs: 0, cooldownMs: 1000, priority: 70, queue: "queue",
          enabled: true, volume: 0.4, position: "fullscreen", entrance: "pop", exit: "fade", muted: false,
          clipStartMs: 200, clipEndMs: 2200,
        },
      ],
      assignments: [{ id: "a1", source: "manual", moment: "wow", effectId: "clip-1" }],
      sequence: [{ id: "s1", effectId: "clip-1", delayMs: 0 }],
    };
    const savePack = await fetch(`${backend.base}/api/workspaces/${workspaceId}/packs/${packUid}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
      body: JSON.stringify(packBody),
    });
    expect(savePack.status).toBe(200);
    const activate = await fetch(`${backend.base}/api/workspaces/${workspaceId}/activate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
      body: JSON.stringify({ packUid }),
    });
    expect(activate.status).toBe(200);

    // Load into the visual editor: proves import/export compatibility.
    await app.getByRole("button", { name: "Load into editor" }).click();
    await expect(app.getByText(/Loaded .* into the Editor/)).toBeAttached({ timeout: 15000 });
    await app.getByRole("button", { name: "Editor", exact: true }).click();
    await expect(app.getByRole("button", { name: /\(video\)/ })).toBeAttached({ timeout: 15000 });
    await app.getByRole("button", { name: "Cloud", exact: true }).click();

    // Hosted overlay session.
    await app.getByLabel("New overlay name").fill("OBS Main");
    await app.getByRole("button", { name: "Create overlay" }).click();
    const urlLocator = app.locator('[data-testid^="hosted-url-"]');
    await expect(urlLocator.first()).toBeAttached({ timeout: 15000 });
    const overlayUrl = (await urlLocator.first().textContent())?.trim() ?? "";
    expect(overlayUrl).toContain("/o/");

    const overlay: Page = await browser.newPage();
    try {
      await overlayConnected(backend.base, overlayUrl, overlay);

      // Fire from the Cloud panel: the correct overlay receives it.
      await app.bringToFront();
      await app.getByLabel("Cloud effect pack").selectOption(packUid);
      await expect(app.getByRole("option", { name: "Clip" })).toBeAttached({ timeout: 15000 });
      await app.getByLabel("Cloud effect", { exact: true }).selectOption("clip-1");
      await app.getByRole("button", { name: "Fire cloud effect" }).click();
      await expect(app.getByText(/Reaction sent to 1 hosted overlay/)).toBeAttached({ timeout: 15000 });

      const audio = overlay.locator("#stage audio");
      await expect(audio).toBeAttached({ timeout: 15000 });
      expect(await audio.getAttribute("src")).toContain("/media/sting.wav");
      await overlay.waitForFunction(
        () => {
          const el = document.querySelector("#stage audio") as HTMLAudioElement | null;
          return el !== null && !el.paused;
        },
        { timeout: 15000 }
      );
      await overlay.waitForFunction(
        () => (window as unknown as { __liveEdits?: { idle: () => boolean } }).__liveEdits?.idle() === true,
        { timeout: 30000 }
      );
    } finally {
      await overlay.close();
    }

    // Reconnect: a fresh overlay page on the same session resyncs and plays.
    const overlayAgain: Page = await browser.newPage();
    try {
      await overlayConnected(backend.base, overlayUrl, overlayAgain);
      await app.bringToFront();
      await app.getByRole("button", { name: "Fire cloud effect" }).click();
      await expect(app.getByText(/Reaction sent to 1 hosted overlay/)).toBeAttached({ timeout: 15000 });
      await expect(overlayAgain.locator("#stage audio")).toBeAttached({ timeout: 15000 });
      await overlayAgain.waitForFunction(
        () => (window as unknown as { __liveEdits?: { idle: () => boolean } }).__liveEdits?.idle() === true,
        { timeout: 30000 }
      );
    } finally {
      await overlayAgain.close();
    }

    // Rotate: the old URL dies immediately, the new one works.
    await app.bringToFront();
    await app.getByRole("button", { name: "Rotate", exact: true }).click();
    await expect(app.getByText(/token rotated/i)).toBeAttached({ timeout: 15000 });
    const rotatedUrl = (await urlLocator.first().textContent())?.trim() ?? "";
    expect(rotatedUrl).toBeTruthy();
    expect(rotatedUrl).not.toBe(overlayUrl);
    expect(await fetch(overlayUrl).then((r) => r.status)).toBe(403);
    const overlayRotated: Page = await browser.newPage();
    try {
      await overlayConnected(backend.base, rotatedUrl, overlayRotated);
      await app.bringToFront();
      await app.getByRole("button", { name: "Fire cloud effect" }).click();
      await expect(app.getByText(/Reaction sent to 1 hosted overlay/)).toBeAttached({ timeout: 15000 });
      await expect(overlayRotated.locator("#stage audio")).toBeAttached({ timeout: 15000 });
    } finally {
      await overlayRotated.close();
    }

    // Other workspace cannot access this one (tenant isolation over HTTP).
    const registerB = await (await fetch(`${backend.base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "cloud-b@example.com", password: "correct-horse-99" }),
    })).json() as { token: string };
    const otherWs = await (await fetch(`${backend.base}/api/workspaces`, {
      method: "POST",
      headers: { Authorization: `Bearer ${registerB.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Rival" }),
    })).json() as { workspace: { id: string } };
    const probe = await fetch(`${backend.base}/api/workspaces/${workspaceId}/packs`, {
      headers: { Authorization: `Bearer ${registerB.token}` },
    });
    expect(probe.status).toBe(404);
    const crossFire = await fetch(`${backend.base}/api/workspaces/${workspaceId}/trigger`, {
      method: "POST",
      headers: { Authorization: `Bearer ${registerB.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ moment: "wow" }),
    });
    expect(crossFire.status).toBe(404);

    // Rival overlay connects but never receives our workspace's triggers.
    const rivalOverlay = await (await fetch(`${backend.base}/api/workspaces/${otherWs.workspace.id}/overlays`, {
      method: "POST",
      headers: { Authorization: `Bearer ${registerB.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Rival OBS" }),
    })).json() as { overlay: { id: string }; viewToken: string };
    const rivalPage: Page = await browser.newPage();
    try {
      await overlayConnected(backend.base, `${backend.base}/o/${rivalOverlay.overlay.id}?token=${rivalOverlay.viewToken}`, rivalPage);
      await app.bringToFront();
      await app.getByRole("button", { name: "Fire cloud effect" }).click();
      await expect(app.getByText(/Reaction sent to \d+ hosted overlay/)).toBeAttached({ timeout: 15000 });
      await rivalPage.waitForTimeout(800);
      expect(await rivalPage.locator("#stage").innerHTML()).toBe("");
    } finally {
      await rivalPage.close();
    }

    // Revoke stops delivery: the overlay URL is rejected afterwards.
    await app.bringToFront();
    await app.getByRole("button", { name: "Revoke" }).click();
    const revoked = await fetch(overlayUrl);
    expect(revoked.status).toBe(403);
    await revoked.arrayBuffer().catch(() => undefined);

    // Reload keeps packs across sessions (token + workspace persist).
    await app.reload({ waitUntil: "networkidle" });
    await app.getByRole("button", { name: "Cloud", exact: true }).click();
    await expect(app.getByRole("option", { name: /Stream Team/ })).toBeAttached({ timeout: 15000 });
    await expect(app.getByText("Cloud Pack").first()).toBeAttached({ timeout: 15000 });
  } finally {
    await app.close();
  }
});
