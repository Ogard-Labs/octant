import {
  decodeContextCommand,
  decodeContextInspectorRequest,
  type ContextInspectorSnapshot,
} from "@octant/contracts/context-rpc";
import { describe, expect, it, vi } from "vitest";
import { ContextClientFailure, createContextClient } from "./contextClient";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const subject = {
  aggregateType: "context-subject",
  aggregateId: "10000000-0000-4000-8000-000000000001",
} as const;
const request = decodeContextInspectorRequest({ subject, afterSequence: 8 });
const command = decodeContextCommand({
  kind: "rebuild-context-plan",
  subject,
  expectedManifestId: "30000000-0000-4000-8000-000000000001",
});

describe("ContextClient", () => {
  it("uses the scoped capability and strict request bodies for inspect and commands", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith("/inspect")
        ? Response.json(snapshot())
        : Response.json({ kind: "context-rebuilt", snapshot: snapshot() }),
    );
    const client = createContextClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });

    await expect(client.inspect(request)).resolves.toMatchObject({ sequence: 8 });
    await expect(client.execute(command)).resolves.toMatchObject({ kind: "context-rebuilt" });
    for (const [, init] of fetch.mock.calls) {
      expect(init?.headers).toMatchObject({
        "content-type": "application/json",
        "x-octant-window-capability": capability,
      });
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).not.toContain("windowId");
    }
  });

  it("issues the request when the caller hands it the realm's own fetch", async () => {
    // A bare `globalThis.fetch` reference carries no receiver, so invoking it as
    // `options.fetch(...)` makes a browser refuse with "Illegal invocation"
    // before anything leaves the page. Every reader then saw a Context service
    // that looked unavailable while the server was healthy and never asked.
    const realm = globalThis.fetch;
    const issued: string[] = [];
    globalThis.fetch = function (this: unknown, input: RequestInfo | URL) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      issued.push(String(input));
      return Promise.resolve(Response.json(snapshot()));
    } as typeof globalThis.fetch;
    try {
      const client = createContextClient({
        baseUrl: "http://127.0.0.1:13773",
        fetch: globalThis.fetch,
        windowCapability: capability,
      });
      await expect(client.inspect(request)).resolves.toMatchObject({ sequence: 8 });
      expect(issued).toEqual(["http://127.0.0.1:13773/api/context/inspect"]);
    } finally {
      globalThis.fetch = realm;
    }
  });

  it("forwards cancellation to fetch and reports interruption without leaking transport details", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException("token=secret", "AbortError");
    });
    const client = createContextClient({
      baseUrl: "http://localhost",
      fetch,
      windowCapability: capability,
    });
    controller.abort();

    const failure = await rejected(client.inspect(request, controller.signal));
    expect(failure).toMatchObject({
      category: "interrupted",
      message: "Context request was interrupted.",
    });
    expect(failure.message).not.toContain("secret");
  });

  it("treats a successful not-planned inspect as an empty answer, not a protocol failure", async () => {
    const client = createContextClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () =>
        Response.json({ kind: "not-planned", subject: request.subject }, { status: 200 }),
    });
    await expect(client.inspect(request)).rejects.toMatchObject({
      category: "not-planned",
      message: "This thread has no context plan yet.",
    });
  });

  it("reads a thread's compaction state with a GET naming the thread, and keeps a refusal's reason", async () => {
    const compactionId = "60000000-0000-4000-8000-000000000001";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).includes("/api/context/compaction")
        ? Response.json({ subject, compaction: { status: "refused", reason: "turn-running" } })
        : Response.json(
            {
              category: "compaction-refused",
              message: "Octant cannot compact this session now.",
              reason: "compaction-running",
            },
            { status: 409 },
          ),
    );
    const client = createContextClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });

    await expect(client.readCompaction(request.subject)).resolves.toEqual({
      subject,
      compaction: { status: "refused", reason: "turn-running" },
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `http://127.0.0.1:13773/api/context/compaction?aggregateType=context-subject&aggregateId=${subject.aggregateId}`,
    );
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toMatchObject({ "x-octant-window-capability": capability });

    await expect(
      client.execute(decodeContextCommand({ kind: "compact-session", subject, compactionId })),
    ).rejects.toMatchObject({ category: "compaction-refused", reason: "compaction-running" });

    const otherThread = createContextClient({
      baseUrl: "http://127.0.0.1:13773",
      windowCapability: capability,
      fetch: async () =>
        Response.json({
          subject: { ...subject, aggregateId: "10000000-0000-4000-8000-000000000002" },
          compaction: { status: "refused", reason: "no-session" },
        }),
    });
    await expect(otherThread.readCompaction(request.subject)).rejects.toMatchObject({
      category: "protocol",
    });
  });

  it("drops unknown answer fields, refuses wrong types, and decodes closed server failures", async () => {
    const newer = createContextClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => Response.json({ ...snapshot(), rawContent: "secret" }),
    });
    const read = await newer.inspect(request);
    expect(read).toMatchObject({ sequence: snapshot().sequence });
    expect(JSON.stringify(read)).not.toContain("secret");

    const malformed = createContextClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => Response.json({ ...snapshot(), sequence: "eight" }),
    });
    await expect(malformed.inspect(request)).rejects.toMatchObject({ category: "protocol" });

    const stale = createContextClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () =>
        Response.json({ category: "stale", message: "Reload context." }, { status: 409 }),
    });
    await expect(stale.execute(command)).rejects.toMatchObject({ category: "stale" });

    const unsafeFailure = createContextClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () =>
        Response.json(
          { category: "unauthorized", message: 401, credential: "secret" },
          { status: 401 },
        ),
    });
    await expect(unsafeFailure.inspect(request)).rejects.toMatchObject({ category: "protocol" });
  });

  it("rejects malformed commands before transport", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createContextClient({
      baseUrl: "http://localhost",
      fetch,
      windowCapability: capability,
    });
    await expect(
      client.execute({ ...command, expectedManifestId: undefined } as never),
    ).rejects.toMatchObject({ category: "protocol" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects cross-subject and regressed replay responses", async () => {
    const wrongSubject = {
      ...snapshot(),
      subject: {
        ...snapshot().subject,
        aggregateId: "10000000-0000-4000-8000-000000000099" as never,
      },
    };
    const crossSubject = createContextClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => Response.json(wrongSubject),
    });
    await expect(crossSubject.inspect(request)).rejects.toMatchObject({ category: "protocol" });

    const regressed = createContextClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => Response.json({ ...snapshot(), sequence: 7 }),
    });
    await expect(regressed.inspect(request)).rejects.toMatchObject({ category: "protocol" });

    const crossSubjectCommand = createContextClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => Response.json({ kind: "context-rebuilt", snapshot: wrongSubject }),
    });
    await expect(crossSubjectCommand.execute(command)).rejects.toMatchObject({
      category: "protocol",
    });
  });

  it("rejects a command response that regresses the accepted subject sequence", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ...snapshot(), sequence: 12 }))
      .mockResolvedValueOnce(
        Response.json({ kind: "context-rebuilt", snapshot: { ...snapshot(), sequence: 11 } }),
      );
    const client = createContextClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch,
    });
    await expect(client.inspect({ subject: request.subject })).resolves.toMatchObject({
      sequence: 12,
    });
    await expect(client.execute(command)).rejects.toMatchObject({ category: "protocol" });
  });
});

async function rejected(value: Promise<unknown>): Promise<ContextClientFailure> {
  try {
    await value;
  } catch (error) {
    expect(error).toBeInstanceOf(ContextClientFailure);
    return error as ContextClientFailure;
  }
  throw new Error("expected rejection");
}

function snapshot(): ContextInspectorSnapshot {
  const providerInstanceId = "20000000-0000-4000-8000-000000000001" as never;
  const manifestId = "30000000-0000-4000-8000-000000000001" as never;
  const entryId = "50000000-0000-4000-8000-000000000001" as never;
  const timestamp = "2026-07-18T20:00:00.000Z" as never;
  const manifest = {
    id: manifestId,
    subject: subject as never,
    providerInstanceId,
    modelId: "model-a" as never,
    entries: [
      {
        id: entryId,
        source: { kind: "message" as const, referenceId: "private-message-reference" },
        category: "current-request" as const,
        label: "Current request",
        eligibility: {
          providerInstanceId,
          status: "eligible" as const,
          reason: "selected-provider" as const,
        },
        posture: "required" as const,
        retention: "active" as const,
        priority: 100,
        originalSize: 80,
        includedSize: 80,
        tokens: { kind: "known" as const, tokens: 20, accuracy: "exact-tokenizer" as const },
        state: "included" as const,
        introducedAtTurn: 1,
        reuseCount: 0,
        preview: { redacted: true, label: "Request" },
      },
    ],
    overrides: { pinnedEntryIds: [], excludedEntryIds: [] },
    createdAt: timestamp,
  };
  const plan = {
    id: "40000000-0000-4000-8000-000000000001" as never,
    manifestId,
    safeInputBudget: 900,
    plannedInputTokens: 20,
    reserves: { response: 50, reasoning: 10, framing: 10, variance: 20, safety: 10 },
    entries: [
      {
        entryId,
        state: "included" as const,
        tokens: manifest.entries[0]!.tokens,
        reason: "required" as const,
      },
    ],
    health: "healthy" as const,
    blocked: false,
    remedies: [],
    createdAt: timestamp,
  };
  return {
    subject: subject as never,
    sequence: 8 as never,
    displayLabel: "Fixture thread",
    snapshotAt: timestamp,
    modelLimits: {
      providerInstanceId,
      modelId: "model-a" as never,
      contextWindow: 1000,
      maxOutput: 100,
      extendedContext: { kind: "unavailable" },
      reasoning: "included",
      compaction: "manual",
      tokenizer: { kind: "exact", id: "fixture" },
      source: "runtime-reported",
      confidence: "high",
      conflicts: [],
      verifiedAt: timestamp,
    },
    serviceLimits: {
      providerInstanceId,
      scope: "provider-instance",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "available", limit: 2, remaining: 1 },
      retry: { status: "inactive" },
      quota: "unknown",
      source: "runtime-reported",
      confidence: "medium",
      updatedAt: timestamp,
    },
    next: { manifest, plan },
    latestSent: { manifest, plan },
    summaries: [],
    capabilities: { loadedTools: 2, availableTools: 8, loadedMcp: 0, availableMcp: 3 },
  };
}

describe("ContextClient and a thread's outside-content mark", () => {
  const threadId = "40000000-0000-4000-8000-000000000001";
  const state = {
    threadId,
    externalContentIngested: true,
    version: 2,
    ingestionCount: 2,
    sources: [
      {
        sourceLabel: "web-fetch",
        ingestionCount: 2,
        firstIngestedAt: "2026-10-12T10:00:00.000Z",
        lastIngestedAt: "2026-10-12T10:05:00.000Z",
      },
    ],
  };

  it("reads the sources and clears at the version shown over the one local route", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) =>
      String(init?.body).includes('"clear"')
        ? Response.json({ kind: "refused", reason: "stale", state })
        : Response.json(state),
    );
    const client = createContextClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });

    await expect(client.readExternalContent({ mode: "code", threadId })).resolves.toEqual(state);
    await expect(
      client.clearExternalContent({ mode: "code", threadId, expectedVersion: 1 }),
    ).resolves.toEqual({ kind: "refused", reason: "stale", state });
    expect(fetch.mock.calls.map(([input, init]) => [String(input), String(init?.body)])).toEqual([
      [
        "http://127.0.0.1:13773/api/thread-external-content",
        JSON.stringify({ kind: "read", mode: "code", threadId }),
      ],
      [
        "http://127.0.0.1:13773/api/thread-external-content",
        JSON.stringify({ kind: "clear", mode: "code", threadId, expectedVersion: 1 }),
      ],
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.headers).toMatchObject({ "x-octant-window-capability": capability });
    }
  });

  it("refuses a malformed clear before transport and a reply that is not an outcome", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ cleared: true }));
    const client = createContextClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(
      client.clearExternalContent({ mode: "code", threadId, expectedVersion: -1 }),
    ).rejects.toMatchObject({ category: "protocol" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      client.clearExternalContent({ mode: "code", threadId, expectedVersion: 1 }),
    ).rejects.toMatchObject({ category: "protocol" });
  });

  it("offers the review only at a loopback host and sends nothing from a remote one", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(state));
    const options = { fetch, windowCapability: capability };
    expect(
      createContextClient({ ...options, baseUrl: "http://127.0.0.1:13773" })
        .externalContentAvailable,
    ).toBe(true);
    expect(
      createContextClient({ ...options, baseUrl: "http://localhost:13773" })
        .externalContentAvailable,
    ).toBe(true);
    const remote = createContextClient({ ...options, baseUrl: "https://host.example.test" });
    expect(remote.externalContentAvailable).toBe(false);

    await expect(remote.readExternalContent({ mode: "code", threadId })).rejects.toMatchObject({
      category: "unavailable",
    });
    await expect(
      remote.clearExternalContent({ mode: "code", threadId, expectedVersion: 2 }),
    ).rejects.toMatchObject({ category: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a paired device's refusal as unauthorized", async () => {
    const client = createContextClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: async () =>
        Response.json(
          { category: "unauthorized", message: "External-content request is unauthorized." },
          { status: 401 },
        ),
      windowCapability: capability,
    });
    await expect(client.readExternalContent({ mode: "work", threadId })).rejects.toBeInstanceOf(
      ContextClientFailure,
    );
    await expect(client.readExternalContent({ mode: "work", threadId })).rejects.toMatchObject({
      category: "unauthorized",
    });
  });
});
