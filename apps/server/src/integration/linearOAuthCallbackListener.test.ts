import { describe, expect, it, vi } from "vitest";
import {
  LINEAR_OAUTH_CALLBACK_PATH,
  startLinearOAuthCallbackListener,
} from "./linearOAuthCallbackListener";

describe("Linear OAuth callback listener", () => {
  it("binds loopback, accepts a single-use code, and does not echo the code", async () => {
    const onAuthorize = vi.fn(async () => ({ kind: "stored" as const }));
    const listener = await startLinearOAuthCallbackListener({
      onAuthorize,
      ports: [0],
    });
    try {
      expect(listener.redirectUri).toContain(LINEAR_OAUTH_CALLBACK_PATH);
      expect(listener.redirectUri.startsWith("http://127.0.0.1:")).toBe(true);
      const code = "authorization-code-secret";
      const response = await fetch(`${listener.redirectUri}?code=${code}&state=csrf-state`);
      expect(response.status).toBe(200);
      expect(onAuthorize).toHaveBeenCalledWith({ code, state: "csrf-state" });
      const text = await response.text();
      expect(text).toContain("Linear is connected");
      expect(text).not.toContain(code);
      const replay = await fetch(`${listener.redirectUri}?code=${code}&state=csrf-state`).catch(
        () => undefined,
      );
      expect(replay?.status ?? 0).not.toBe(200);
    } finally {
      await listener.close();
    }
  });

  it("rejects extra query parameters and non-loopback-shaped paths", async () => {
    const onAuthorize = vi.fn(async () => ({ kind: "stored" as const }));
    const listener = await startLinearOAuthCallbackListener({
      onAuthorize,
      ports: [0],
    });
    try {
      const extra = await fetch(`${listener.redirectUri}?code=one&state=two&debug=true`);
      expect(extra.status).toBe(400);
      expect(onAuthorize).not.toHaveBeenCalled();
      const wrongPath = await fetch(listener.redirectUri.replace(LINEAR_OAUTH_CALLBACK_PATH, "/"));
      expect(wrongPath.status).toBe(404);
    } finally {
      await listener.close();
    }
  });
});
