import { decodeBrowserPageScriptPlanId } from "@octant/contracts/browser-page-script";
import { describe, expect, it, vi } from "vitest";
import { startBrowserRuntimeBroker } from "./browserRuntimeBroker";
import { BrowserNavigationBlockedError, BrowserTargetStaleError } from "./browserSurfaceHost";

const contextId = "10000000-0000-4000-8000-000000000001";

function host() {
  const personInput: Array<(contextId: string) => void> = [];
  return {
    personInput,
    runPageScript: vi.fn(
      async (
        _command: import("@octant/contracts/browser-page-script").BrowserPageScriptNativeCommand,
        _signal: AbortSignal,
      ): Promise<import("@octant/contracts/browser-page-script").BrowserPageScriptPreparation> => ({
        status: "completed",
        effect: "possible",
        valueJson: "42",
      }),
    ),
    prepareCredentialFill: vi.fn(async () => ({
      status: "prepared",
      planId: contextId,
      usernameLabel: "Email",
      passwordLabel: "Password",
      submissionOrigin: "https://example.com",
      expiresAt: new Date(Date.now() + 180000).toISOString(),
    })),
    submitCredentialFill: vi.fn(async () => ({
      status: "authentication-required",
      effect: "completed",
    })),
    onPersonInput: vi.fn((listener: (contextId: string) => void) => {
      personInput.push(listener);
      return () => undefined;
    }),
    available: () => true,
    act: vi.fn(async () => ({ url: "https://example.com/" })),
    peek: vi.fn(async () => ({
      url: "https://example.com/",
      screenshotDataUrl: "data:image/jpeg;base64,AAAA",
    })),
    closeAll: vi.fn(async () => undefined),
    closeContext: vi.fn(async () => undefined),
    createContext: vi.fn(async () => undefined),
    inspectTarget: vi.fn(async () => ({ sensitive: false })),
    onContextGone: vi.fn(() => () => undefined),
    claimDownload: vi.fn(
      (): string | undefined => "/tmp/octant-browser-downloads/desktop/d-1/file",
    ),
    discardDownload: vi.fn(async () => undefined),
  };
}

describe("BrowserRuntimeBroker", () => {
  it("keeps a normally completed HTTP preparation current for its subsequent execute request", async () => {
    const surface = host();
    let preparationSignal: AbortSignal | undefined;
    surface.runPageScript.mockImplementation(async (command, signal) => {
      if (command.operation === "prepare") {
        preparationSignal = signal;
        return { status: "prepared", planId: decodeBrowserPageScriptPlanId(contextId) };
      }
      return preparationSignal?.aborted === false && !signal.aborted
        ? { status: "completed", effect: "possible", valueJson: "42" }
        : { status: "cancelled", effect: "none" };
    });
    const broker = await startBrowserRuntimeBroker(surface as never);
    const owner = { windowId: contextId, threadId: contextId };
    try {
      const prepared = await fetch(
        request(
          broker.url,
          broker.token,
          {
            operation: "prepare",
            contextId,
            owner,
            source: "42",
            expectedUrl: "https://example.com/",
          },
          "v1/contexts/page-script",
        ),
      );
      expect((await prepared.json()).status).toBe("prepared");
      expect(preparationSignal?.aborted).toBe(false);
      const result = await fetch(
        request(
          broker.url,
          broker.token,
          { operation: "execute", contextId, owner, planId: contextId },
          "v1/contexts/page-script",
        ),
      );
      expect(await result.json()).toEqual({
        status: "completed",
        effect: "possible",
        valueJson: "42",
      });
    } finally {
      await broker.close();
    }
  });

  it("cancels an owned script after a complete HTTP POST disconnects before effect admission", async () => {
    const surface = host();
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false,
      starts = 0,
      settled = false;
    let nativeSignal: AbortSignal | undefined;
    surface.runPageScript.mockImplementation(async (_command, signal) => {
      entered = true;
      nativeSignal = signal;
      await waiting;
      if (signal.aborted) {
        settled = true;
        return { status: "cancelled", effect: "none" };
      }
      starts++;
      settled = true;
      return { status: "completed", effect: "possible", valueJson: "42" };
    });
    const broker = await startBrowserRuntimeBroker(surface as never);
    const abort = new AbortController();
    const pending = fetch(
      request(
        broker.url,
        broker.token,
        {
          operation: "execute",
          contextId,
          owner: { windowId: contextId, threadId: contextId },
          planId: contextId,
        },
        "v1/contexts/page-script",
      ),
      { signal: abort.signal },
    ).catch(() => undefined);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      abort.abort();
      await pending;
      await vi.waitFor(() => expect(nativeSignal?.aborted).toBe(true));
      release?.();
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(starts).toBe(0);
    } finally {
      release?.();
      await pending;
      await broker.close();
    }
  });

  it("requires private native authentication, strict script phases and a bounded final reply", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never);
    const command = {
      operation: "prepare",
      contextId,
      owner: { windowId: contextId, threadId: contextId },
      source: "42",
      expectedUrl: "https://example.com/",
    };
    const path = "v1/contexts/page-script";
    try {
      expect((await broker.fetchForTest(request(broker.url, "wrong", command, path))).status).toBe(
        401,
      );
      expect(
        (
          await broker.fetchForTest(
            request(broker.url, broker.token, { ...command, source: "😀".repeat(2049) }, path),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await broker.fetchForTest(
            request(
              broker.url,
              broker.token,
              {
                operation: "execute",
                contextId,
                owner: command.owner,
                planId: contextId,
                source: "unapproved-change",
              },
              path,
            ),
          )
        ).status,
      ).toBe(400);
      expect(surface.runPageScript).not.toHaveBeenCalled();
      const valid = await broker.fetchForTest(request(broker.url, broker.token, command, path));
      expect(await valid.json()).toEqual({
        status: "completed",
        effect: "possible",
        valueJson: "42",
      });
      surface.runPageScript.mockResolvedValue({
        status: "completed",
        effect: "possible",
        valueJson: "\u0000".repeat(6000),
      });
      const bounded = await broker.fetchForTest(request(broker.url, broker.token, command, path));
      expect(await bounded.json()).toEqual({ status: "truncated", effect: "possible" });
    } finally {
      await broker.close();
    }
  });

  it("authenticates and strictly decodes reference-only credential form requests", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never);
    const command = {
      kind: "prepare",
      contextId,
      owner: { windowId: contextId, threadId: contextId },
      origin: "https://example.com",
    };
    try {
      const path = "v1/contexts/credential-fill";
      expect((await broker.fetchForTest(request(broker.url, "wrong", command, path))).status).toBe(
        401,
      );
      expect(
        (
          await broker.fetchForTest(
            request(broker.url, broker.token, { ...command, password: "must-not-cross" }, path),
          )
        ).status,
      ).toBe(400);
      expect(surface.prepareCredentialFill).not.toHaveBeenCalled();
      const response = await broker.fetchForTest(request(broker.url, broker.token, command, path));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "prepared",
        submissionOrigin: "https://example.com",
      });
      expect(surface.prepareCredentialFill).toHaveBeenCalledWith(
        contextId,
        command.owner,
        command.origin,
      );
      const expiresAt = new Date(Date.now() + 180000).toISOString();
      const submitted = await broker.fetchForTest(
        request(
          broker.url,
          broker.token,
          { kind: "submit", contextId, owner: command.owner, planId: contextId, expiresAt },
          path,
        ),
      );
      expect(await submitted.json()).toEqual({
        status: "authentication-required",
        effect: "completed",
      });
      expect(surface.submitCredentialFill).toHaveBeenCalledWith(
        contextId,
        command.owner,
        contextId,
        expiresAt,
      );
    } finally {
      await broker.close();
    }
  });

  it("reports the pages the person used once, to the server that asks", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never);
    try {
      surface.personInput[0]?.(contextId);
      surface.personInput[0]?.(contextId);
      const first = await broker.fetchForTest(
        request(broker.url, broker.token, {}, "v1/contexts/person-input"),
      );
      expect(await first.json()).toEqual({ contextIds: [contextId] });
      const second = await broker.fetchForTest(
        request(broker.url, broker.token, {}, "v1/contexts/person-input"),
      );
      expect(await second.json()).toEqual({ contextIds: [] });
      const refused = await broker.fetchForTest(
        request(broker.url, "wrong", {}, "v1/contexts/person-input"),
      );
      expect(refused.status).toBe(401);
    } finally {
      await broker.close();
    }
  });

  it("accepts only authenticated bounded interactive actions", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never);
    try {
      const response = await broker.fetchForTest(
        request(broker.url, broker.token, {
          contextId,
          request: {
            kind: "click",
            point: { x: 0.5, y: 0.25 },
          },
        }),
      );

      expect(response.status).toBe(200);
      expect(surface.act).toHaveBeenCalledWith(contextId, {
        kind: "click",
        point: { x: 0.5, y: 0.25 },
      });

      const invalid = await broker.fetchForTest(
        request(broker.url, broker.token, {
          contextId,
          request: { kind: "scroll", deltaY: 2001 },
        }),
      );
      expect(invalid.status).toBe(400);
      expect(surface.act).toHaveBeenCalledOnce();
    } finally {
      await broker.close();
    }
  });

  it("passes the hold flag through only as the fixed value, and claims or discards by id", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never);
    try {
      const held = await broker.fetchForTest(
        request(broker.url, broker.token, {
          contextId,
          request: { kind: "click", target: "#get", downloads: "hold" },
        }),
      );
      expect(held.status).toBe(200);
      expect(surface.act).toHaveBeenCalledWith(contextId, {
        kind: "click",
        target: "#get",
        downloads: "hold",
      });
      const other = await broker.fetchForTest(
        request(broker.url, broker.token, {
          contextId,
          request: { kind: "click", target: "#get", downloads: "allow" },
        }),
      );
      expect(other.status).toBe(400);

      const claimed = await broker.fetchForTest(
        request(
          broker.url,
          broker.token,
          { contextId, downloadId: "d1" },
          "v1/contexts/download-claim",
        ),
      );
      expect(await claimed.json()).toEqual({
        path: "/tmp/octant-browser-downloads/desktop/d-1/file",
      });
      surface.claimDownload.mockReturnValueOnce(undefined);
      const missing = await broker.fetchForTest(
        request(
          broker.url,
          broker.token,
          { contextId, downloadId: "d2" },
          "v1/contexts/download-claim",
        ),
      );
      expect(await missing.json()).toEqual({ path: null });
      const discarded = await broker.fetchForTest(
        request(
          broker.url,
          broker.token,
          { contextId, downloadId: "d1" },
          "v1/contexts/download-discard",
        ),
      );
      expect(discarded.status).toBe(200);
      expect(surface.discardDownload).toHaveBeenCalledWith(contextId, "d1");
      const bad = await broker.fetchForTest(
        request(
          broker.url,
          broker.token,
          { contextId, downloadId: "../../etc/passwd" },
          "v1/contexts/download-claim",
        ),
      );
      expect(bad.status).toBe(400);
    } finally {
      await broker.close();
    }
  });

  it("accepts the diagnostics read as a bounded action", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never);
    try {
      const response = await broker.fetchForTest(
        request(broker.url, broker.token, { contextId, request: { kind: "observe-diagnostics" } }),
      );

      expect(response.status).toBe(200);
      expect(surface.act).toHaveBeenCalledWith(contextId, { kind: "observe-diagnostics" });
    } finally {
      await broker.close();
    }
  });

  it("returns a picture of the page on peek without treating it as an action", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never);
    try {
      const response = await broker.fetchForTest(
        new Request(new URL("v1/contexts/peek", broker.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-browser-broker-token": broker.token,
          },
          body: JSON.stringify({ contextId }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        url: "https://example.com/",
        screenshotDataUrl: "data:image/jpeg;base64,AAAA",
      });
      expect(surface.peek).toHaveBeenCalledWith(contextId);
      expect(surface.act).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it("reports a refused off-origin navigation as a structured 422", async () => {
    const surface = host();
    surface.act.mockRejectedValueOnce(
      new BrowserNavigationBlockedError("https://www.example.com/"),
    );
    const broker = await startBrowserRuntimeBroker(surface as never);
    try {
      const response = await broker.fetchForTest(
        request(broker.url, broker.token, {
          contextId,
          request: { kind: "navigate", target: "https://example.com/" },
        }),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "navigation-blocked",
        url: "https://www.example.com/",
      });
    } finally {
      await broker.close();
    }
  });

  it("passes a snapshot ref's expected element through and reports a stale one as a structured 422", async () => {
    const surface = host();
    surface.act.mockRejectedValueOnce(new BrowserTargetStaleError());
    const broker = await startBrowserRuntimeBroker(surface as never);
    try {
      const action = {
        kind: "click",
        target: "#save",
        expected: { role: "button", name: "Save", url: "https://example.com/" },
      };
      const response = await broker.fetchForTest(
        request(broker.url, broker.token, { contextId, request: action }),
      );
      expect(surface.act).toHaveBeenCalledWith(contextId, action);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "target-stale" });
    } finally {
      await broker.close();
    }
  });

  it("refuses a resize outside the bounds and a malformed wait before the page is touched", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never);
    try {
      for (const action of [
        { kind: "resize", viewport: { width: 9000, height: 800 } },
        { kind: "resize", colorScheme: "sepia" },
        { kind: "resize", touch: "yes" },
        { kind: "resize", mobile: true },
        { kind: "resize", viewport: { width: 390, height: 844 }, deviceScaleFactor: 40 },
        { kind: "wait", waitFor: { conditions: [], match: "all" } },
        { kind: "wait", waitFor: { conditions: [{ kind: "text", text: "x" }], match: "all" } },
      ]) {
        const response = await broker.fetchForTest(
          request(broker.url, broker.token, { contextId, request: action }),
        );
        expect(response.status).toBe(400);
      }
      expect(surface.act).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it("rejects remote or unauthenticated callers", async () => {
    const broker = await startBrowserRuntimeBroker(host() as never);
    try {
      const unauthenticated = new Request(new URL("v1/available", broker.url), {
        method: "POST",
      });
      expect((await broker.fetchForTest(unauthenticated)).status).toBe(401);
      expect(
        (await broker.fetchForTest(request(broker.url, broker.token, {}), "192.0.2.1")).status,
      ).toBe(401);
    } finally {
      await broker.close();
    }
  });
});

function request(url: string, token: string, body: unknown, path = "v1/contexts/act"): Request {
  return new Request(new URL(path, url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-browser-broker-token": token,
    },
    body: JSON.stringify(body),
  });
}

describe("BrowserRuntimeBroker profiles", () => {
  const projectId = "40000000-0000-4000-8000-000000000001";
  function store() {
    return {
      list: vi.fn(async () => [{ profile: { kind: "personal" as const }, sizeBytes: 12 }]),
      clear: vi.fn(async () => undefined),
      syncExtensions: vi.fn(async () => undefined),
      extensionPage: vi.fn(() => undefined),
      extensionOfElectronId: vi.fn(() => undefined),
      extensionActionScope: vi.fn(() => undefined),
      importCookies: vi.fn(async (_profile: unknown, cookies: ReadonlyArray<unknown>) => ({
        imported: cookies.length,
        skipped: 0,
      })),
    };
  }
  const post = (broker: { url: string; token: string }, path: string, body: unknown) =>
    request(broker.url, broker.token, body, path);

  it("lists and clears stored profiles for the authenticated server only", async () => {
    const profiles = store();
    const broker = await startBrowserRuntimeBroker(host() as never, profiles);
    try {
      const listed = await broker.fetchForTest(post(broker, "v1/profiles/list", {}));
      expect(await listed.json()).toEqual({
        profiles: [{ profile: { kind: "personal" }, sizeBytes: 12 }],
      });

      const cleared = await broker.fetchForTest(
        post(broker, "v1/profiles/clear", {
          profile: { kind: "project", projectId },
          scope: "cookies",
        }),
      );
      expect(cleared.status).toBe(200);
      expect(profiles.clear).toHaveBeenCalledWith({ kind: "project", projectId }, "cookies");

      const wrongToken = await broker.fetchForTest(
        request(
          broker.url,
          "wrong",
          { profile: { kind: "personal" }, scope: "all" },
          "v1/profiles/clear",
        ),
      );
      expect(wrongToken.status).toBe(401);
      expect(profiles.clear).toHaveBeenCalledOnce();
    } finally {
      await broker.close();
    }
  });

  it("refuses a profile it cannot name or a scope it does not know, clearing nothing", async () => {
    const profiles = store();
    const broker = await startBrowserRuntimeBroker(host() as never, profiles);
    try {
      for (const body of [
        { profile: { kind: "private" }, scope: "all" },
        { profile: { kind: "project", projectId: "../../etc" }, scope: "all" },
        { profile: { kind: "personal" }, scope: "everything" },
        { profile: { kind: "personal", partition: "persist:other" }, scope: "all" },
      ]) {
        const response = await broker.fetchForTest(post(broker, "v1/profiles/clear", body));
        expect(response.status).toBe(400);
      }
      expect(profiles.clear).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it("loads the extensions the server names into a stored profile, and refuses anything else", async () => {
    const profiles = store();
    const broker = await startBrowserRuntimeBroker(host() as never, profiles);
    try {
      const entry = {
        id: "a".repeat(32),
        path: "/data/browser-extensions/x",
        contentHash: "b".repeat(64),
      };
      const ok = await broker.fetchForTest(
        post(broker, "v1/extensions/sync", { profile: { kind: "personal" }, extensions: [entry] }),
      );
      expect(ok.status).toBe(200);
      expect(profiles.syncExtensions).toHaveBeenCalledWith({ kind: "personal" }, [entry]);

      for (const body of [
        { profile: { kind: "private" }, extensions: [] },
        { profile: { kind: "personal" }, extensions: [{ ...entry, path: "relative/folder" }] },
        { profile: { kind: "personal" }, extensions: [{ ...entry, id: "../../x" }] },
        { profile: { kind: "personal" }, extensions: [{ ...entry, contentHash: "short" }] },
        { profile: { kind: "personal" }, extensions: "all" },
      ]) {
        const response = await broker.fetchForTest(post(broker, "v1/extensions/sync", body));
        expect(response.status).toBe(400);
      }
      expect(profiles.syncExtensions).toHaveBeenCalledOnce();
    } finally {
      await broker.close();
    }
  });

  it("says plainly that profiles are unavailable when the app keeps none", async () => {
    const broker = await startBrowserRuntimeBroker(host() as never);
    try {
      const response = await broker.fetchForTest(post(broker, "v1/profiles/list", {}));
      expect(response.status).toBe(409);
    } finally {
      await broker.close();
    }
  });

  it("accepts a stored profile in a context's policy and refuses a malformed one", async () => {
    const surface = host();
    const broker = await startBrowserRuntimeBroker(surface as never, store());
    try {
      const policy = (profile: unknown) => ({
        profileMode: "isolated",
        profile,
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 2,
        sessionTimeoutMs: 300_000,
      });
      const create = (profile: unknown) =>
        broker.fetchForTest(
          post(broker, "v1/contexts/create", {
            contextId,
            owner: { windowId: "window-a", threadId: contextId },
            policy: policy(profile),
          }),
        );

      expect((await create({ kind: "personal" })).status).toBe(200);
      expect((await create({ kind: "personal", partition: "x" })).status).toBe(400);
      expect((await create({ kind: "everyone" })).status).toBe(400);
      expect(surface.createContext).toHaveBeenCalledOnce();
    } finally {
      await broker.close();
    }
  });

  it("imports a bounded batch of well-formed cookies and refuses anything else", async () => {
    const profiles = store();
    const broker = await startBrowserRuntimeBroker(host() as never, profiles);
    const cookie = {
      domain: ".example.com",
      hostOnly: false,
      name: "sid",
      value: "v",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    };
    try {
      const ok = await broker.fetchForTest(
        post(broker, "v1/profiles/import-cookies", {
          profile: { kind: "personal" },
          cookies: [cookie],
        }),
      );
      expect(await ok.json()).toEqual({ imported: 1, skipped: 0 });
      expect(profiles.importCookies).toHaveBeenCalledWith({ kind: "personal" }, [cookie]);

      for (const body of [
        { profile: { kind: "private" }, cookies: [cookie] },
        { profile: { kind: "personal" }, cookies: [{ ...cookie, sameSite: "whatever" }] },
        { profile: { kind: "personal" }, cookies: [{ ...cookie, extra: true }] },
        { profile: { kind: "personal" }, cookies: Array.from({ length: 201 }, () => cookie) },
        { profile: { kind: "personal" } },
      ]) {
        const refused = await broker.fetchForTest(post(broker, "v1/profiles/import-cookies", body));
        expect(refused.status).toBe(400);
      }
      expect(profiles.importCookies).toHaveBeenCalledOnce();

      const unauthorized = await broker.fetchForTest(
        request(
          broker.url,
          "wrong",
          { profile: { kind: "personal" }, cookies: [cookie] },
          "v1/profiles/import-cookies",
        ),
      );
      expect(unauthorized.status).toBe(401);
    } finally {
      await broker.close();
    }
  });

  it("takes a larger body for a cookie batch than for any other route", async () => {
    const profiles = store();
    const broker = await startBrowserRuntimeBroker(host() as never, profiles);
    try {
      const big = {
        profile: { kind: "personal" },
        cookies: Array.from({ length: 100 }, (_, index) => ({
          domain: ".example.com",
          hostOnly: false,
          name: `c${String(index)}`,
          value: "v".repeat(2_000),
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
        })),
      };
      expect(JSON.stringify(big).length).toBeGreaterThan(96 * 1024);

      const response = await broker.fetchForTest(post(broker, "v1/profiles/import-cookies", big));

      expect(response.status).toBe(200);
    } finally {
      await broker.close();
    }
  });
});
