import { decodeAppleSnapshotRequest } from "@octant/contracts/apple-toolchain-rpc";
import { decodeContextInspectorRequest } from "@octant/contracts/context-rpc";
import { decodePreviewTarget } from "@octant/contracts/previews";
import { describe, expect, it } from "vitest";
import { createAppleToolchainClient } from "./appleToolchainClient";
import { createComputerUseClient } from "./computerUseClient";
import { createContextClient } from "./contextClient";
import { createPreviewClient } from "./previewClient";
import { createProviderUsageLimitsClient } from "./providerUsageLimitsClient";

/**
 * A browser's `fetch` is branded to its Window. Handing a client the bare
 * `globalThis.fetch` and then invoking it as `options.fetch(...)` gives the
 * call a plain object as its receiver, and the browser refuses with "Illegal
 * invocation" before the request leaves the page. The client reports that as a
 * transport failure, so a reader sees an unavailable service while the server
 * is healthy and was never asked.
 *
 * `globalThis.fetch` in this runtime is not brand-checked, so the check is
 * modelled here: the stand-in refuses any receiver that is not the realm.
 */
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const baseUrl = "http://127.0.0.1:13773/";

function brandCheckedRealmFetch(issued: string[]): typeof globalThis.fetch {
  return function (this: unknown, input: RequestInfo | URL) {
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    issued.push(String(input));
    return Promise.resolve(Response.json({}));
  } as typeof globalThis.fetch;
}

const previewTarget = decodePreviewTarget({
  targetId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  hostId: "33333333-3333-4333-8333-333333333333",
  kind: "file",
  opaqueRef: "opaque-token-1",
  displayName: "notes.md",
});

const inspectRequest = decodeContextInspectorRequest({
  subject: {
    aggregateType: "context-subject",
    aggregateId: "10000000-0000-4000-8000-000000000001",
  },
});

const snapshotRequest = decodeAppleSnapshotRequest({
  kind: "apple-snapshot-request",
  authority: {
    hostId: "4f70656e-4f72-4269-9474-4c6f63616c31",
    mode: "code",
    projectId: "90000000-0000-4000-8000-000000000001",
    providerInstanceId: "90000000-0000-4000-8000-000000000002",
    extension: { kind: "core" },
  },
  threadId: "90000000-0000-4000-8000-000000000003",
  checkoutId: "90000000-0000-4000-8000-000000000004",
});

const clients = [
  {
    name: "context",
    ask: (fetch: typeof globalThis.fetch) =>
      createContextClient({ baseUrl, fetch, windowCapability: capability }).inspect(inspectRequest),
  },
  {
    name: "apple toolchain",
    ask: (fetch: typeof globalThis.fetch) =>
      createAppleToolchainClient({ baseUrl, fetch, windowCapability: capability }).snapshot(
        snapshotRequest,
      ),
  },
  {
    name: "computer use",
    ask: (fetch: typeof globalThis.fetch) =>
      createComputerUseClient({ baseUrl, fetch, windowCapability: capability }).list(),
  },
  {
    name: "preview",
    ask: (fetch: typeof globalThis.fetch) =>
      createPreviewClient({ baseUrl, fetch, windowCapability: capability }).open(previewTarget),
  },
  {
    name: "provider usage limits",
    ask: (fetch: typeof globalThis.fetch) =>
      createProviderUsageLimitsClient({ baseUrl, fetch, windowCapability: capability }).list(),
  },
] as const;

describe("clients handed the realm's own fetch", () => {
  for (const client of clients) {
    it(`issues the ${client.name} request instead of refusing it in the page`, async () => {
      const realm = globalThis.fetch;
      const issued: string[] = [];
      globalThis.fetch = brandCheckedRealmFetch(issued);
      try {
        // Only the transport matters here: a decode or protocol refusal after
        // the request went out still proves the call reached the network.
        await client.ask(globalThis.fetch).catch((error: unknown) => {
          expect(String(error)).not.toContain("Illegal invocation");
        });
        expect(issued.length).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = realm;
      }
    });
  }
});
