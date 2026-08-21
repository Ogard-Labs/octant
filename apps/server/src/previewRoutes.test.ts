import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeCodeThreadId,
  decodeProjectId,
  decodeShellBootstrap,
  decodeWindowId,
} from "@octant/contracts";
import { decodePreviewHostId, decodePreviewTargetId } from "@octant/contracts/previews";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createPreviewRouteHandler, resolvePreviewActiveContext } from "./previewRoutes";
import { PreviewService } from "./preview/previewService";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000801");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000802");
const codeThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000803");
const hostId = decodePreviewHostId("33333333-3333-4333-8333-333333333333");
const otherHostId = decodePreviewHostId("44444444-4444-4444-8444-444444444444");
const targetId = decodePreviewTargetId("11111111-1111-4111-8111-111111111111");

function makeTarget(overrides: Record<string, unknown> = {}) {
  return {
    targetId,
    projectId,
    hostId,
    kind: "file",
    opaqueRef: "opaque-token-1",
    displayName: "notes.md",
    ...overrides,
  };
}

function makeService(
  root: string,
  records: Map<string, { relativePath: string; displayName: string }>,
) {
  return new PreviewService({
    hostId,
    budget: { maxSniffBytes: 4096, maxByteSize: 1024 * 1024, maxRenderBytes: 1024 * 1024 },
    textBudget: { maxLinesPerChunk: 4, maxBytesPerChunk: 1024 },
    targetResolver: {
      async resolve({ opaqueRef }) {
        const record = records.get(opaqueRef);
        if (record === undefined) return { ok: false, code: "not-found" };
        return { ok: true, ...record };
      },
    },
    projectRootResolver: {
      async resolve(id) {
        if (id !== projectId) return { ok: false, code: "unavailable" };
        return { ok: true, canonicalRoot: root };
      },
    },
    uuid: () => "66666666-6666-4666-8666-666666666666",
  });
}

function createRoute(
  service: PreviewService,
  options: {
    readonly accessible?: boolean;
    readonly projectType?: "chat" | "work" | "code";
    readonly activeThreadId?: typeof codeThreadId;
    readonly posture?: "plan" | "approval-gated" | "full";
  } = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  return createPreviewRouteHandler({
    service,
    windowAuthorityStore: store,
    hostId,
    projects: {
      bootstrap: vi.fn().mockResolvedValue({
        active:
          options.accessible === false
            ? []
            : [
                {
                  id: projectId,
                  name: "Knowledge",
                  type: options.projectType ?? "work",
                  lifecycle: "active",
                },
              ],
        archived: [],
      }),
    },
    activeContextResolver: vi.fn().mockResolvedValue({
      mode: options.projectType ?? "work",
      projectId: options.accessible === false ? null : projectId,
      ...(options.activeThreadId === undefined ? {} : { activeThreadId: options.activeThreadId }),
    }),
    ...(options.posture === undefined
      ? {}
      : { postureResolver: vi.fn().mockResolvedValue(options.posture) }),
    now: () => 1,
  });
}

describe("Preview routes", () => {
  let root: string;
  let records: Map<string, { relativePath: string; displayName: string }>;
  let service: PreviewService;
  let route: ReturnType<typeof createRoute>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "preview-routes-"));
    records = new Map([["opaque-token-1", { relativePath: "notes.md", displayName: "notes.md" }]]);
    writeFileSync(join(root, "notes.md"), "# Title\nbody line\n");
    service = makeService(root, records);
    route = createRoute(service);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("opens a markdown target and returns a ready outcome with no host path", async () => {
    const response = await route(
      new Request("http://127.0.0.1/api/preview/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget() }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.kind).toBe("ready");
    expect(body.manifest.kind).toBe("markdown");
    expect(JSON.stringify(body)).not.toContain(root);
  });

  it("streams text chunks through the authenticated chunks route", async () => {
    writeFileSync(join(root, "notes.md"), "line1\nline2\nline3\nline4\nline5\n");
    const openResponse = await route(
      new Request("http://127.0.0.1/api/preview/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget() }),
      }),
    );
    const openBody = await openResponse?.json();
    const response = await route(
      new Request("http://127.0.0.1/api/preview/chunks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          target: makeTarget(),
          sourceVersion: openBody.manifest.sourceVersion,
          afterSequence: 0,
          maxChunks: 2,
        }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.kind).toBe("chunks");
    expect(body.chunks).toHaveLength(2);
  });

  it("returns unauthorized with only the target id for a target minted for another host", async () => {
    const response = await route(
      new Request("http://127.0.0.1/api/preview/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget({ hostId: otherHostId }) }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ kind: "unauthorized", targetId });
  });

  it("rejects a request without a window capability with 401", async () => {
    const response = await route(
      new Request("http://127.0.0.1/api/preview/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: makeTarget() }),
      }),
    );
    expect(response?.status).toBe(401);
  });

  it("rejects a non-loopback host", async () => {
    const response = await route(
      new Request("http://example.com/api/preview/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget() }),
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("rejects a GET request to the open route", async () => {
    const response = await route(
      new Request("http://127.0.0.1/api/preview/open", {
        method: "GET",
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("returns unauthorized when the target project is not active for the window", async () => {
    const inaccessibleRoute = createRoute(service, { accessible: false });
    const response = await inaccessibleRoute(
      new Request("http://127.0.0.1/api/preview/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget() }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ kind: "unauthorized", targetId });
  });

  it("does not treat another globally active Project as active for this window", async () => {
    const otherWindowRoute = createRoute(service, { accessible: false });
    const response = await otherWindowRoute(
      new Request("http://127.0.0.1/api/preview/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget() }),
      }),
    );
    expect(await response?.json()).toEqual({ kind: "unauthorized", targetId });
  });

  it("authorizes a thread-bound Code target only for the active Code thread", async () => {
    const codeRoot = mkdtempSync(join(tmpdir(), "preview-code-routes-"));
    writeFileSync(join(codeRoot, "notes.md"), "# Code\n");
    const codeRecords = new Map([
      ["opaque-token-1", { relativePath: "notes.md", displayName: "notes.md" }],
    ]);
    const codeService = makeService(codeRoot, codeRecords);
    try {
      const allowedRoute = createRoute(codeService, {
        projectType: "code",
        activeThreadId: codeThreadId,
      });
      const allowed = await allowedRoute(
        new Request("http://127.0.0.1/api/preview/open", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
          },
          body: JSON.stringify({ target: makeTarget({ boundCodeThreadId: codeThreadId }) }),
        }),
      );
      const allowedBody = await allowed?.json();
      expect(allowedBody).toMatchObject({ kind: "ready" });

      const deniedRoute = createRoute(codeService, { projectType: "code" });
      const denied = await deniedRoute(
        new Request("http://127.0.0.1/api/preview/open", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
          },
          body: JSON.stringify({ target: makeTarget({ boundCodeThreadId: codeThreadId }) }),
        }),
      );
      expect(await denied?.json()).toEqual({ kind: "unauthorized", targetId });
    } finally {
      rmSync(codeRoot, { recursive: true, force: true });
    }
  });

  it("refresh surfaces stale when the known version no longer matches", async () => {
    const openResponse = await route(
      new Request("http://127.0.0.1/api/preview/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget() }),
      }),
    );
    const openBody = await openResponse?.json();
    const staleVersion = {
      ...openBody.manifest.sourceVersion,
      contentSha256: "0".repeat(64),
    };
    const response = await route(
      new Request("http://127.0.0.1/api/preview/refresh", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget(), knownVersion: staleVersion }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.kind).toBe("stale");
  });

  it("cancel returns not-found when no stream is in flight", async () => {
    const response = await route(
      new Request("http://127.0.0.1/api/preview/cancel", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget() }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ kind: "not-found" });
  });

  it("returns 404 for an unknown preview sub-route", async () => {
    const response = await route(
      new Request("http://127.0.0.1/api/preview/unknown", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget() }),
      }),
    );
    expect(response).toBeUndefined();
  });

  it("handoff resolves a local-window reveal request to done with no path", async () => {
    const response = await route(
      new Request("http://127.0.0.1/api/preview/handoff", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget(), kind: "reveal-in-finder" }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ kind: "done", handoffKind: "reveal-in-finder" });
    expect(JSON.stringify(body)).not.toContain(root);
    expect(JSON.stringify(body)).not.toContain("/");
  });

  it("handoff returns unauthorized with only the target id for a target minted for another host", async () => {
    const response = await route(
      new Request("http://127.0.0.1/api/preview/handoff", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          target: makeTarget({ hostId: otherHostId }),
          kind: "open-external",
        }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ kind: "unauthorized", targetId });
    expect(JSON.stringify(body)).not.toContain(root);
  });

  it("handoff fails closed in plan mode", async () => {
    const planRoute = createRoute(service, { posture: "plan" });
    const response = await planRoute(
      new Request("http://127.0.0.1/api/preview/handoff", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget(), kind: "quick-look" }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ kind: "unauthorized", targetId });
    expect(JSON.stringify(body)).not.toContain(root);
  });

  it("handoff rejects an invalid kind with 400", async () => {
    const response = await route(
      new Request("http://127.0.0.1/api/preview/handoff", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget(), kind: "shell-open" }),
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("handoff surfaces cancellation as a failed reply without a path", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await route(
      new Request("http://127.0.0.1/api/preview/handoff", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ target: makeTarget(), kind: "open-external" }),
        signal: controller.signal,
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ kind: "failed", reason: "cancelled" });
    expect(JSON.stringify(body)).not.toContain(root);
  });
});

describe("resolvePreviewActiveContext", () => {
  it("derives the active Project and Code thread from the active pane's surface", () => {
    const bootstrap = decodeShellBootstrap({
      settings: {
        chatEnabled: true,
        workEnabled: true,
        sidebarWidth: 280,
        contextSidebarWidth: 360,
        lastContextSurface: null,
        sidebarMaterial: "system",
        modeSwitcherPresentation: "buttons",
      },
      workspace: {
        windowId,
        activeMode: "code",
        layouts: {
          chat: {
            kind: "pane",
            nodeId: "00000000-0000-4000-8000-000000000901",
            paneId: "00000000-0000-4000-8000-000000000902",
            surface: {
              kind: "welcome",
              id: "00000000-0000-4000-8000-000000000903",
              mode: "chat",
              title: "Chat",
            },
          },
          work: {
            kind: "pane",
            nodeId: "00000000-0000-4000-8000-000000000904",
            paneId: "00000000-0000-4000-8000-000000000905",
            surface: {
              kind: "welcome",
              id: "00000000-0000-4000-8000-000000000906",
              mode: "work",
              title: "Work",
            },
          },
          code: {
            kind: "pane",
            nodeId: "00000000-0000-4000-8000-000000000907",
            paneId: "00000000-0000-4000-8000-000000000908",
            surface: {
              kind: "code-file",
              id: "00000000-0000-4000-8000-000000000909",
              threadId: codeThreadId,
              mode: "code",
              title: "Code",
              relativePath: "notes.md",
            },
          },
        },
        activePaneIds: {
          chat: "00000000-0000-4000-8000-000000000902",
          work: "00000000-0000-4000-8000-000000000905",
          code: "00000000-0000-4000-8000-000000000908",
        },
        contextByMode: {
          chat: { host: "local", mode: "chat", projectId: null, boundRoot: null },
          work: { host: "local", mode: "work", projectId: null, boundRoot: null },
          code: { host: "local", mode: "code", projectId, boundRoot: "/repo" },
        },
        version: 0,
      },
      availableSurfaces: {
        chat: [],
        work: [],
        code: [],
      },
      connectionStatus: "connected",
      environmentPresentation: {
        byTab: [],
        byMode: { chat: "hidden", work: "floating", code: "pinned" },
      },
      settingsVersion: 0,
      workspaceVersion: 0,
      presentationVersion: 0,
    });

    expect(resolvePreviewActiveContext(bootstrap)).toEqual({
      mode: "code",
      projectId,
      activeThreadId: codeThreadId,
    });
  });
});
