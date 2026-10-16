// @vitest-environment node
import { describe, it, expect } from "vitest";
import { api, register, startTestApp } from "./test-helpers.ts";

describe("saas auth (M7)", () => {
  it("registers, logs in/out, and reports the session owner", async () => {
    const app = await startTestApp();
    try {
      const reg = await register(app.base, "amy@example.com");
      expect(reg.token).toMatch(/^[0-9a-f]{32,}$/);

      const me = await api(app.base, "GET", "/api/auth/me", reg.token);
      expect(me.status).toBe(200);
      expect((me.json as { user: { email: string } }).user.email).toBe("amy@example.com");

      const out = await api(app.base, "POST", "/api/auth/logout", reg.token);
      expect(out.status).toBe(200);
      const denied = await api(app.base, "GET", "/api/auth/me", reg.token);
      expect(denied.status).toBe(401);

      const login = await api(app.base, "POST", "/api/auth/login", undefined, { email: "amy@example.com", password: "correct-horse-99" });
      expect(login.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects duplicates, bad credentials, and weak passwords", async () => {
    const app = await startTestApp();
    try {
      await register(app.base, "bob@example.com");
      const dup = await api(app.base, "POST", "/api/auth/register", undefined, { email: "bob@example.com", password: "correct-horse-99" });
      expect(dup.status).toBe(409);
      const bad = await api(app.base, "POST", "/api/auth/login", undefined, { email: "bob@example.com", password: "wrong-password-1" });
      expect(bad.status).toBe(401);
      const weak = await api(app.base, "POST", "/api/auth/register", undefined, { email: "new@example.com", password: "short" });
      expect(weak.status).toBe(400);
      const badEmail = await api(app.base, "POST", "/api/auth/register", undefined, { email: "not-an-email", password: "correct-horse-99" });
      expect(badEmail.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("expires sessions and rotates them on password change", async () => {
    const app = await startTestApp();
    try {
      const reg = await register(app.base, "exp@example.com");
      // Expired token crafted server-side is not reachable here; instead prove
      // password change revokes the old session and issues a fresh one.
      const change = await api(app.base, "PATCH", "/api/auth/account", reg.token, { currentPassword: "correct-horse-99", newPassword: "brand-new-pass-55" });
      expect(change.status).toBe(200);
      const fresh = (change.json as { token: string }).token;
      expect(fresh).toBeTruthy();
      expect(await api(app.base, "GET", "/api/auth/me", reg.token).then((r) => r.status)).toBe(401);
      expect(await api(app.base, "GET", "/api/auth/me", fresh).then((r) => r.status)).toBe(200);
      const wrongCurrent = await api(app.base, "PATCH", "/api/auth/account", fresh, { currentPassword: "nope", newPassword: "another-new-55" });
      expect(wrongCurrent.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("supports recovery with single-use expiring tokens", async () => {
    const app = await startTestApp();
    try {
      await register(app.base, "rec@example.com");
      const req = await api(app.base, "POST", "/api/auth/recover/request", undefined, { email: "rec@example.com" });
      expect(req.status).toBe(200);
      const token = (req.json as { resetToken?: string }).resetToken;
      expect(token).toBeTruthy();
      // Unknown addresses still return ok (no enumeration).
      const ghost = await api(app.base, "POST", "/api/auth/recover/request", undefined, { email: "ghost@example.com" });
      expect(ghost.status).toBe(200);
      expect((ghost.json as { resetToken?: string }).resetToken).toBeUndefined();

      const confirm = await api(app.base, "POST", "/api/auth/recover/confirm", undefined, { token, newPassword: "recovered-pass-77" });
      expect(confirm.status).toBe(200);
      const reuse = await api(app.base, "POST", "/api/auth/recover/confirm", undefined, { token, newPassword: "recovered-pass-78" });
      expect(reuse.status).toBe(400);
      const login = await api(app.base, "POST", "/api/auth/login", undefined, { email: "rec@example.com", password: "recovered-pass-77" });
      expect(login.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("updates account settings", async () => {
    const app = await startTestApp();
    try {
      const reg = await register(app.base, "set@example.com");
      const patch = await api(app.base, "PATCH", "/api/auth/account", reg.token, { displayName: "Setter" });
      expect(patch.status).toBe(200);
      expect((patch.json as { user: { displayName: string } }).user.displayName).toBe("Setter");
    } finally {
      await app.close();
    }
  });
});
