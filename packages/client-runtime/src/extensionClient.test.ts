import { describe, expect, it } from "vitest";
import { createExtensionClient, ExtensionClientFailure } from "./extensionClient";

const capability = "window-capability";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("extension client", () => {
  it("routes catalog, preview, inspect, lifecycle, and snapshot requests through the typed API", async () => {
    const urls: Array<string> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      urls.push(new URL(String(input)).pathname);
      expect(init?.headers).toMatchObject({ "x-octant-window-capability": capability });
      if (urls.at(-1) === "/api/extensions/snapshot") {
        return response({
          sequence: 0,
          snapshotAt: "2026-07-28T12:00:00.000Z",
          packages: [],
          collisions: [],
        });
      }
      if (urls.at(-1) === "/api/extensions/catalog") {
        return response({ kind: "catalog-search-results", entries: [] });
      }
      if (urls.at(-1) === "/api/extensions/preview") {
        return response({
          kind: "package-preview",
          preview: { entry: catalogEntry(), review: packageReview(), diagnostics: [] },
        });
      }
      return response({
        kind: "package-inspected",
        preview: { entry: catalogEntry(), review: packageReview(), diagnostics: [] },
      });
    };
    const client = createExtensionClient({
      baseUrl: "http://127.0.0.1",
      fetch,
      windowCapability: capability,
    });
    const source = { kind: "local-folder", sourceRef: "fixture" } as never;

    await client.snapshot();
    await client.execute({ kind: "search-catalog", query: "fixture" });
    await client.execute({ kind: "preview-package", source });
    await client.execute({ kind: "inspect-package", source });
    await client.execute({
      kind: "uninstall-package",
      extensionId: "44000000-0000-4000-8000-000000000002" as never,
      packageId: "44000000-0000-4000-8000-000000000003" as never,
    });

    expect(urls).toEqual([
      "/api/extensions/snapshot",
      "/api/extensions/catalog",
      "/api/extensions/preview",
      "/api/extensions/inspect",
      "/api/extensions/lifecycle",
    ]);
  });

  it("reports transport failures without exposing response content", async () => {
    const fetch: typeof globalThis.fetch = async () => response({ secret: "must-not-leak" }, 500);
    const client = createExtensionClient({
      baseUrl: "http://127.0.0.1",
      fetch,
      windowCapability: capability,
    });

    await expect(client.snapshot()).rejects.toEqual(
      expect.objectContaining({
        name: "ExtensionClientFailure",
        category: "unavailable",
        message: "Extension request failed.",
      } satisfies Partial<ExtensionClientFailure>),
    );
  });

  it("submits only an opaque native-picker receipt for local plugin import", async () => {
    const receiptId = "R".repeat(43);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/api/extensions/import-local");
      expect(JSON.parse(String(init?.body))).toEqual({ receiptId });
      expect(String(init?.body)).not.toContain("/Users/");
      return response({
        kind: "package-inspected",
        preview: { entry: catalogEntry(), review: packageReview(), diagnostics: [] },
      });
    };
    const client = createExtensionClient({
      baseUrl: "http://127.0.0.1",
      fetch,
      windowCapability: capability,
    });

    await expect(client.importLocalPluginReceipt(receiptId)).resolves.toMatchObject({
      kind: "package-inspected",
    });
    await expect(client.importLocalPluginReceipt("/Users/demo/plugin")).rejects.toMatchObject({
      category: "invalid",
    });
  });

  it("synchronizes scoped effective state through the authenticated state route", async () => {
    const scope = {
      hostId: "local",
      mode: "code",
      projectId: null,
      threadId: null,
      providerFamily: "ollama",
    } as const;
    const catalogEpoch = `sha256:${"b".repeat(64)}`;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/api/extensions/state");
      expect(init?.headers).toMatchObject({
        "content-type": "application/json",
        "x-octant-window-capability": capability,
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        kind: "query-effective-state",
        commandVersion: 1,
        scope,
        expectedCatalogEpoch: catalogEpoch,
      });
      return response({
        kind: "extension-effective-state",
        snapshot: {
          sequence: 4,
          snapshotAt: "2026-07-28T12:00:00.000Z",
          scope,
          catalogEpoch,
          catalogStatus: "available",
          stale: false,
          packages: [],
          collisions: [],
        },
      });
    };
    const client = createExtensionClient({
      baseUrl: "http://127.0.0.1",
      fetch,
      windowCapability: capability,
    });

    await expect(
      client.effectiveState({ scope, expectedCatalogEpoch: catalogEpoch } as never),
    ).resolves.toMatchObject({ catalogEpoch, scope, stale: false });
  });

  it("forwards cancellation to extension command requests", async () => {
    const controller = new AbortController();
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return response({ kind: "skill-search-results", entries: [] });
    };
    const client = createExtensionClient({
      baseUrl: "http://127.0.0.1",
      fetch,
      windowCapability: capability,
    });

    await client.execute({ kind: "search-skills", query: "review" }, controller.signal);
  });

  it("lists and decides pending extension tool approvals", async () => {
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.kind === "list") return response([]);
      expect(body).toEqual({
        kind: "decide",
        approvalId: "44000000-0000-4000-8000-000000000010",
        decision: "denied",
      });
      return response({ accepted: true });
    };
    const client = createExtensionClient({
      baseUrl: "http://127.0.0.1",
      fetch,
      windowCapability: capability,
    });

    await expect(client.listToolApprovals()).resolves.toEqual([]);
    await expect(
      client.decideToolApproval({
        approvalId: "44000000-0000-4000-8000-000000000010",
        decision: "denied",
      }),
    ).resolves.toBe(true);
  });
});

function catalogEntry() {
  return {
    extensionId: "44000000-0000-4000-8000-000000000002",
    packageId: "44000000-0000-4000-8000-000000000003",
    slug: "fixture",
    displayName: "Fixture",
    version: "1.0.0",
    digest: `sha256:${"a".repeat(64)}`,
    source: { kind: "local-folder", sourceRef: "fixture" },
  };
}

function packageReview() {
  return {
    provenance: {
      canonicalUrl: "https://example.com/fixture",
      publisher: "Example Publisher",
      reviewed: false,
    },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
    declaredCapabilities: ["mcp"],
    components: [
      {
        id: "server",
        kind: "mcp-server",
        displayName: "Server",
        declaredCapabilities: ["mcp"],
      },
    ],
  };
}
