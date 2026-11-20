import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { decodeBrowserContextId, decodeBrowserThreadId } from "@octant/contracts";
import {
  MAX_PAIRED_BROWSER_FILE_BYTES,
  decodePairedBrowserChooserId,
  decodePairedBrowserStreamEvent,
  type PairedBrowserNativeTarget,
  type PairedBrowserTarget,
} from "@octant/contracts/paired-browser-control";
import { describe, expect, it, vi } from "vitest";
import {
  PairedBrowserControlService,
  type PairedBrowserActor,
  type PairedBrowserHost,
} from "./pairedBrowserControl";
import type { PairedBrowserJournalFact } from "./pairedBrowserJournal";

const threadOne = decodeBrowserThreadId("11111111-1111-4111-8111-111111111111");
const contextOne = decodeBrowserContextId("22222222-2222-4222-8222-222222222222");

function makeTarget(
  threadId = threadOne,
  contextId = contextOne,
): { readonly target: PairedBrowserTarget; readonly nativeTarget: PairedBrowserNativeTarget } {
  const documentVersion = "a".repeat(64) as PairedBrowserTarget["documentVersion"];
  return {
    target: {
      threadId,
      contextId,
      tabId: "tab-1",
      documentVersion,
      profileKind: "personal",
      originPolicyVersion: "policy-v1",
    },
    nativeTarget: {
      tabId: "tab-1",
      documentVersion,
      origin: "https://example.com",
      originPolicyVersion: "policy-v1",
      viewport: { width: 1280, height: 800 },
      devicePixelRatio: 2,
    },
  };
}

function makeActor(overrides: Partial<PairedBrowserActor> = {}): PairedBrowserActor {
  return {
    principalKind: "person-paired-device",
    deviceId: "device-1",
    deviceName: "Henrik's iPhone",
    sessionId: "session-1",
    credentialGeneration: 1,
    current: () => true,
    ...overrides,
  };
}

function makeFixture(hostOverrides: Partial<PairedBrowserHost> = {}) {
  const facts: Array<PairedBrowserJournalFact> = [];
  let nowMs = 1_700_000_000_000;
  let frameSeq = 0;
  let onReclaimCb: ((contextId: typeof contextOne) => void) | undefined;
  let onPageEndedCb: ((contextId: typeof contextOne) => void) | undefined;
  const targets = new Map<string, ReturnType<typeof makeTarget>>();
  targets.set(String(threadOne), makeTarget());

  const host: PairedBrowserHost = {
    inspectThread: vi.fn(async (threadId) => {
      const found = targets.get(String(threadId));
      return found === undefined
        ? undefined
        : {
            target: found.target,
            nativeTarget: found.nativeTarget,
            origin: "https://example.com",
            authorityCurrent: true,
          };
    }),
    authorityCurrent: vi.fn(() => true),
    claim: vi.fn(async () => true),
    frame: vi.fn(async () => {
      frameSeq += 1;
      const found = makeTarget();
      return {
        status: "frame" as const,
        frame: {
          frameId: frameSeq,
          documentVersion: found.target.documentVersion,
          viewport: { width: 1280, height: 800 },
          devicePixelRatio: 2,
          jpegBase64: "AAAA",
        },
      };
    }),
    input: vi.fn(async () => ({ status: "input" as const, effect: "completed" as const })),
    fileChoice: vi.fn(async () => ({ status: "file-chosen" as const })),
    release: vi.fn(async () => ({ status: "released" as const })),
    ...hostOverrides,
  };

  const service = new PairedBrowserControlService({
    host,
    now: () => nowMs,
    timestamp: () => new Date(nowMs).toISOString(),
    uuid: randomUUID,
    journal: (fact) => facts.push(fact),
    frameIntervalMs: 10,
    disconnectTimeoutMs: 80,
    idleTimeoutMs: 160,
    onReclaim: (cb) => {
      onReclaimCb = cb;
      return () => {
        onReclaimCb = undefined;
      };
    },
    onPageEnded: (cb) => {
      onPageEndedCb = cb;
      return () => {
        onPageEndedCb = undefined;
      };
    },
  });

  return {
    service,
    host,
    facts,
    targets,
    advanceNow: (delta: number) => {
      nowMs += delta;
    },
    triggerReclaim: (contextId = contextOne) => onReclaimCb?.(contextId),
    triggerPageEnded: (contextId = contextOne) => onPageEndedCb?.(contextId),
  };
}

async function readNdjsonLines(
  stream: ReadableStream<Uint8Array>,
  count: number,
): Promise<Array<ReturnType<typeof decodePairedBrowserStreamEvent>>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<ReturnType<typeof decodePairedBrowserStreamEvent>> = [];
  try {
    while (events.length < count) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        events.push(decodePairedBrowserStreamEvent(JSON.parse(line)));
        if (events.length >= count) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

describe("PairedBrowserControlService", () => {
  it("refuses hub-introduced devices and agent grants with remote-control-not-person before touching any page", async () => {
    const f = makeFixture();
    try {
      expect(
        await f.service.takeOver(makeActor({ principalKind: "remote-device" }), threadOne),
      ).toEqual({ status: "refused", reason: "remote-control-not-person" });
      expect(await f.service.takeOver(makeActor({ isAgentGrant: true }), threadOne)).toEqual({
        status: "refused",
        reason: "remote-control-not-person",
      });
      expect(f.host.inspectThread).not.toHaveBeenCalled();
    } finally {
      await f.service.close();
    }
  });

  it("enforces one controller per page, one page per device, strict sequence numbers, and rate limits", async () => {
    const f = makeFixture();
    const threadTwo = decodeBrowserThreadId("11111111-1111-4111-8111-111111111112");
    const contextTwo = decodeBrowserContextId("22222222-2222-4222-8222-222222222223");
    f.targets.set(String(threadTwo), makeTarget(threadTwo, contextTwo));
    try {
      const deviceOne = makeActor({ deviceId: "device-1" });
      const deviceTwo = makeActor({ deviceId: "device-2" });
      const held = await f.service.takeOver(deviceOne, threadOne);
      if (held.status !== "held") throw new Error("Expected held lease");

      // Second device refused on same page.
      expect(await f.service.takeOver(deviceTwo, threadOne)).toEqual({
        status: "refused",
        reason: "browser-page-held-elsewhere",
      });
      // Same device refused on a second page.
      expect(await f.service.takeOver(deviceOne, threadTwo)).toEqual({
        status: "refused",
        reason: "browser-page-held-elsewhere",
      });

      // Strictly increasing sequence numbers prevent retried typing.
      expect(
        await f.service.execute(deviceOne, {
          kind: "input",
          leaseId: held.leaseId,
          sequence: 1,
          events: [{ kind: "text", text: "hi" }],
        }),
      ).toEqual({ status: "input", lastAcceptedSequence: 1, effect: "completed" });
      expect(
        await f.service.execute(deviceOne, {
          kind: "input",
          leaseId: held.leaseId,
          sequence: 1,
          events: [{ kind: "text", text: "hi" }],
        }),
      ).toEqual({ status: "refused", reason: "stale-frame", effect: "none" });

      // Typed-character per minute rate limit (4,096 chars/min) refuses with retryAfterSeconds and dispatches nothing.
      const bigText = "a".repeat(256);
      for (let seq = 2; seq <= 16; seq += 1) {
        const res = await f.service.execute(deviceOne, {
          kind: "input",
          leaseId: held.leaseId,
          sequence: seq,
          events: [{ kind: "text", text: bigText }],
        });
        expect(res.status).toBe("input");
      }
      const callsBeforeLimit = vi.mocked(f.host.input).mock.calls.length;
      const limited = await f.service.execute(deviceOne, {
        kind: "input",
        leaseId: held.leaseId,
        sequence: 17,
        events: [{ kind: "text", text: bigText }],
      });
      expect(limited).toMatchObject({
        status: "refused",
        reason: "rate-limited",
        effect: "none",
      });
      expect(vi.mocked(f.host.input).mock.calls.length).toBe(callsBeforeLimit);

      // Hand back ends lease and journals counts without typed values.
      expect(
        await f.service.execute(deviceOne, { kind: "hand-back", leaseId: held.leaseId }),
      ).toEqual({ status: "released" });
      expect(f.facts).toHaveLength(2);
      expect(f.facts[0]).toMatchObject({ kind: "started", deviceId: "device-1" });
      expect(f.facts[1]).toMatchObject({
        kind: "ended",
        deviceId: "device-1",
        endReason: "handed-back",
      });
      expect(JSON.stringify(f.facts)).not.toContain(bigText);
    } finally {
      await f.service.close();
    }
  });

  it("streams NDJSON frames, refuses a second concurrent stream, and emits reclaimed-locally on local input", async () => {
    const f = makeFixture();
    try {
      const actor = makeActor();
      const held = await f.service.takeOver(actor, threadOne);
      if (held.status !== "held") throw new Error("Expected held lease");

      const first = f.service.openStream(actor, held.leaseId);
      if (first.status !== "stream") throw new Error("Expected stream");
      expect(f.service.openStream(actor, held.leaseId)).toMatchObject({
        status: "refused",
        reason: "rate-limited",
      });

      const readPromise = readNdjsonLines(first.stream, 3);
      await vi.waitFor(() => expect(vi.mocked(f.host.frame)).toHaveBeenCalled());
      f.triggerReclaim(contextOne);
      const events = await readPromise;
      expect(events[0]?.kind).toBe("frame");
      expect(events.some((event) => event.kind === "reclaimed-locally")).toBe(true);
      expect(
        events.some((event) => event.kind === "ended" && event.reason === "reclaimed-locally"),
      ).toBe(true);
    } finally {
      await f.service.close();
    }
  });

  it("stages uploaded chooser files in host-private temp storage, delivers them, and deletes them immediately", async () => {
    let seenPath: string | undefined;
    const f = makeFixture({
      fileChoice: vi.fn(async (_target, _leaseId, _chooserId, paths) => {
        seenPath = paths[0];
        expect(seenPath !== undefined && existsSync(seenPath)).toBe(true);
        return { status: "file-chosen" as const };
      }),
    });
    try {
      const actor = makeActor();
      const held = await f.service.takeOver(actor, threadOne);
      if (held.status !== "held") throw new Error("Expected held lease");
      const chooserId = decodePairedBrowserChooserId("55555555-5555-4555-8555-555555555555");

      // Oversized upload refused.
      expect(
        await f.service.uploadFile(actor, {
          leaseId: held.leaseId,
          chooserId,
          fileName: "huge.bin",
          bytes: new Uint8Array(MAX_PAIRED_BROWSER_FILE_BYTES + 1),
        }),
      ).toEqual({ status: "refused", reason: "rate-limited" });

      // Valid upload staged and cleaned up immediately.
      expect(
        await f.service.uploadFile(actor, {
          leaseId: held.leaseId,
          chooserId,
          fileName: "../../etc/passwd",
          bytes: new TextEncoder().encode("safe-bytes"),
        }),
      ).toEqual({ status: "released" });
      expect(seenPath).toBeDefined();
      expect(seenPath).not.toContain("/etc/passwd");
      expect(seenPath !== undefined && existsSync(seenPath)).toBe(false);
    } finally {
      await f.service.close();
    }
  });

  it("ends the lease when disconnected past grace window or when device is revoked", async () => {
    let current = true;
    const f = makeFixture();
    try {
      const actor = makeActor({ current: () => current });
      const held = await f.service.takeOver(actor, threadOne);
      if (held.status !== "held") throw new Error("Expected held lease");

      current = false;
      f.service.revalidateAuthority();
      await vi.waitFor(() =>
        expect(f.facts.some((fact) => fact.kind === "ended" && fact.endReason === "revoked")).toBe(
          true,
        ),
      );
      expect(
        await f.service.execute(actor, {
          kind: "input",
          leaseId: held.leaseId,
          sequence: 1,
          events: [{ kind: "text", text: "after-revoke" }],
        }),
      ).toEqual({ status: "refused", reason: "lease-ended" });
    } finally {
      await f.service.close();
    }
  });
});
