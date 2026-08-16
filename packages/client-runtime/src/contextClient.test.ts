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

  it("strictly decodes successes and closed server failures", async () => {
    const malformed = createContextClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => Response.json({ ...snapshot(), rawContent: "secret" }),
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
          { category: "unauthorized", message: "No.", credential: "secret" },
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
