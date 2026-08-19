import { describe, expect, it, vi } from "vitest";
import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import {
  classifyProductAction,
  createAuthenticatedProductDispatch,
} from "./authenticatedProductRoutes";
import { authenticateRouteWindowId, readPrincipalRouteContext } from "./principalRouteContext";

const principal = createRemoteDevicePrincipal({
  hostId: "11111111-1111-4111-8111-111111111111" as StableHostId,
  deviceId: "22222222-2222-4222-8222-222222222222" as DeviceId,
  credentialGeneration: 1,
  origin: "https://octant.example",
  protocolVersion: 1,
  capabilityDigest: "b".repeat(64),
  sessionId: "33333333-3333-4333-8333-333333333333" as RemoteSessionId,
});

function handoff(path: string, method = "GET") {
  const request = new Request(`https://octant.example${path}`, {
    method,
    headers: { host: "octant.example", origin: "https://octant.example" },
  });
  return {
    request,
    principal,
    requestFacts: { method, canonicalPathQuery: path, bodyDigest: "d" },
  };
}

describe("authenticated product route dispatch", () => {
  it("classifies the complete authenticated route prefixes", () => {
    expect(
      classifyProductAction(new Request("https://octant.example/api/agent-profiles/profile-id")),
    ).toBe("settings.read-non-secret");
    expect(
      classifyProductAction(new Request("https://octant.example/api/github/authentication")),
    ).toBe("settings.read-non-secret");
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/github/authentication/commands", {
          method: "POST",
        }),
      ),
    ).toBe("settings.read-non-secret");
    expect(
      classifyProductAction(new Request("https://octant.example/api/projects/project-id/memory")),
    ).toBe("project.overview.read");
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/chat/attachments", { method: "POST" }),
      ),
    ).toBe("chat.send-turn");
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/code/evidence", { method: "PUT" }),
      ),
    ).toBe("code.plan-turn");
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/code/board", { method: "POST" }),
      ),
    ).toBe("project.overview.read");
    // Local servers is its own catalogued authority, not a Code turn.
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/code/local-servers/commands", { method: "POST" }),
      ),
    ).toBe("code.local-servers.list");
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/providers/commands", { method: "POST" }),
      ),
    ).toBeUndefined();
    expect(
      classifyProductAction(new Request("https://octant.example/api/automations/list?mode=all")),
    ).toBe("project.overview.read");
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/automations/commands", { method: "POST" }),
      ),
    ).toBe("automation.manage");
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/automations/list", { method: "POST" }),
      ),
    ).toBeUndefined();
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/diagnostics/export", { method: "POST" }),
      ),
    ).toBe("diagnostics.export");
    expect(
      classifyProductAction(new Request("https://octant.example/api/diagnostics/export")),
    ).toBeUndefined();
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/threads/export", { method: "POST" }),
      ),
    ).toBe("project.overview.read");
  });

  it("fails closed for a remote device attempting a diagnostics export before dispatch", async () => {
    const dispatch = vi.fn(async () => Response.json({ ok: true }));
    const adapter = createAuthenticatedProductDispatch({ dispatch });
    const response = await adapter(handoff("/api/diagnostics/export", "POST"));
    expect(response?.status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("passes a shared remote principal context to the existing product route chain", async () => {
    let signal: AbortSignal | undefined;
    const dispatch = vi.fn(async (request: Request) => {
      const context = readPrincipalRouteContext(request);
      signal = context?.abortSignal;
      const scopeId = authenticateRouteWindowId({ request });
      return Response.json({ kind: context?.principal.kind, scopeId });
    });
    const abortController = new AbortController();
    const product = createAuthenticatedProductDispatch({ dispatch });

    const response = await product({
      ...handoff("/api/chat/bootstrap"),
      abortSignal: abortController.signal,
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ kind: "remote-device" });
    expect(signal).toBe(abortController.signal);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("fails closed before dispatch for unsupported remote mutations", async () => {
    const dispatch = vi.fn(async () => Response.json({ ok: true }));
    const product = createAuthenticatedProductDispatch({ dispatch });

    const response = await product(handoff("/api/providers/commands", "POST"));

    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      category: "unauthorized",
      message: "Remote action is not authorized.",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("allows only cataloged remote chat turns", async () => {
    const dispatch = vi.fn(async () => Response.json({ ok: true }));
    const product = createAuthenticatedProductDispatch({ dispatch });

    const response = await product(handoff("/api/chat/commands", "POST"));

    expect(response?.status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("classifies a Canvas share read as a read and leaves minting and revoking denied", () => {
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/canvas/share-access", { method: "POST" }),
      ),
    ).toBe("project.overview.read");
    // A share names a paired device as its audience, so opening one must reach
    // the route; issuing or withdrawing one is the owner's alone.
    for (const path of ["/api/canvas/share", "/api/canvas/share-revoke"]) {
      expect(
        classifyProductAction(new Request(`https://octant.example${path}`, { method: "POST" })),
      ).toBeUndefined();
    }
  });

  it("dispatches a Canvas share read for a paired device but not a share mutation", async () => {
    const dispatch = vi.fn(async () => Response.json({ ok: true }));
    const product = createAuthenticatedProductDispatch({ dispatch });

    expect((await product(handoff("/api/canvas/share-access", "POST")))?.status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();

    for (const path of ["/api/canvas/share", "/api/canvas/share-revoke"]) {
      expect((await product(handoff(path, "POST")))?.status).toBe(403);
    }
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("classifies watching the host's browser as a read and acting in it as its own action", () => {
    for (const path of [
      "/api/browser/scope",
      "/api/browser/contexts/current",
      "/api/browser/contexts/inspect",
    ]) {
      expect(
        classifyProductAction(new Request(`https://octant.example${path}`, { method: "POST" })),
      ).toBe("browser.observe");
    }
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/browser/actions", { method: "POST" }),
      ),
    ).toBe("browser.interact");
    // Opening, releasing, cancelling, and stopping a browser session decide
    // what the host is running, not what a watcher sees.
    for (const path of [
      "/api/browser/contexts",
      "/api/browser/contexts/release",
      "/api/browser/contexts/cancel",
      "/api/browser/contexts/stop",
    ]) {
      expect(
        classifyProductAction(new Request(`https://octant.example${path}`, { method: "POST" })),
      ).toBeUndefined();
    }
  });

  it("dispatches a browser observation and gesture for a paired device but not a session change", async () => {
    const dispatch = vi.fn(async () => Response.json({ ok: true }));
    const product = createAuthenticatedProductDispatch({ dispatch });

    for (const path of ["/api/browser/contexts/inspect", "/api/browser/actions"]) {
      expect((await product(handoff(path, "POST")))?.status).toBe(200);
    }
    expect(dispatch).toHaveBeenCalledTimes(2);

    for (const path of ["/api/browser/contexts", "/api/browser/contexts/stop"]) {
      expect((await product(handoff(path, "POST")))?.status).toBe(403);
    }
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("classifies the POST-only Usage reads as reads and leaves the ledger purges denied", () => {
    for (const path of ["/api/usage/dashboard", "/api/usage/query", "/api/usage/export"]) {
      expect(
        classifyProductAction(new Request(`https://octant.example${path}`, { method: "POST" })),
      ).toBe("settings.read-non-secret");
    }
    for (const path of ["/api/usage/reset", "/api/usage/retain"]) {
      expect(
        classifyProductAction(new Request(`https://octant.example${path}`, { method: "POST" })),
      ).toBeUndefined();
    }
  });

  it("dispatches the POST-only Usage reads for a paired device but not a ledger purge", async () => {
    const dispatch = vi.fn(async () => Response.json({ ok: true }));
    const product = createAuthenticatedProductDispatch({ dispatch });

    for (const path of ["/api/usage/dashboard", "/api/usage/query", "/api/usage/export"]) {
      const response = await product(handoff(path, "POST"));
      expect(response?.status).toBe(200);
    }
    expect(dispatch).toHaveBeenCalledTimes(3);

    for (const path of ["/api/usage/reset", "/api/usage/retain"]) {
      const response = await product(handoff(path, "POST"));
      expect(response?.status).toBe(403);
    }
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("classifies the POST-only Extension, validation, and Context reads as reads", () => {
    for (const path of [
      "/api/extensions/catalog",
      "/api/extensions/inspect",
      "/api/extensions/preview",
      "/api/extensions/snapshot",
      "/api/extensions/state",
      "/api/validation/evidence",
    ]) {
      expect(
        classifyProductAction(new Request(`https://octant.example${path}`, { method: "POST" })),
      ).toBe("settings.read-non-secret");
    }
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/context/inspect", { method: "POST" }),
      ),
    ).toBe("project.overview.read");
    for (const path of [
      "/api/context/commands",
      "/api/extensions/lifecycle",
      "/api/extensions/skills",
      "/api/extensions/tool-approvals",
      "/api/extensions/import-local",
    ]) {
      expect(
        classifyProductAction(new Request(`https://octant.example${path}`, { method: "POST" })),
      ).toBeUndefined();
    }
    expect(
      classifyProductAction(new Request("https://octant.example/api/projects/project-id/memory")),
    ).toBe("project.overview.read");
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/projects/project-id/memory", { method: "POST" }),
      ),
    ).toBeUndefined();
  });

  it("dispatches the POST-only Extension, validation, and Context reads for a paired device", async () => {
    const dispatch = vi.fn(async () => Response.json({ ok: true }));
    const product = createAuthenticatedProductDispatch({ dispatch });

    for (const path of [
      "/api/extensions/catalog",
      "/api/extensions/inspect",
      "/api/extensions/preview",
      "/api/extensions/snapshot",
      "/api/extensions/state",
      "/api/validation/evidence",
      "/api/context/inspect",
    ]) {
      const response = await product(handoff(path, "POST"));
      expect(response?.status).toBe(200);
    }
    expect(dispatch).toHaveBeenCalledTimes(7);

    for (const path of [
      "/api/context/commands",
      "/api/extensions/lifecycle",
      "/api/extensions/skills",
      "/api/extensions/tool-approvals",
      "/api/extensions/import-local",
    ]) {
      const response = await product(handoff(path, "POST"));
      expect(response?.status).toBe(403);
    }
    expect(dispatch).toHaveBeenCalledTimes(7);
  });

  it("dispatches an explicitly confirmed GitHub lifecycle command for a paired user", async () => {
    const dispatch = vi.fn(async () => Response.json({ ok: true }));
    const product = createAuthenticatedProductDispatch({ dispatch });

    const response = await product(handoff("/api/github/authentication/commands", "POST"));

    expect(response?.status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
