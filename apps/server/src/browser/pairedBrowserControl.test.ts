import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeBrowserContextId, decodeBrowserThreadId } from "@octant/contracts";
import {
  MAX_PAIRED_BROWSER_FILE_BYTES,
  decodePairedBrowserChooserId,
  decodePairedBrowserStreamEvent,
  type PairedBrowserNativeTarget,
  type PairedBrowserTarget,
} from "@octant/contracts/paired-browser-control";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { openSqlite } from "../persistence/sqlitePort";
import { MonotonicRemoteClock } from "../remote/monotonicRemoteClock";
import { RemoteRequestProofService } from "../remoteRequestProofService";
import {
  isPairedDeviceSessionCurrent,
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

  it("retains uploaded chooser files until the browser context ends and deletes them immediately on refusal", async () => {
    let seenPath: string | undefined;
    let refusedPath: string | undefined;
    let shouldRefuse = false;
    const f = makeFixture({
      fileChoice: vi.fn(async (_target, _leaseId, _chooserId, paths) => {
        if (shouldRefuse) {
          refusedPath = paths[0];
          return { status: "refused" as const, reason: "unavailable" as const };
        }
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

      // Refused chooser upload cleans up its staged file immediately.
      shouldRefuse = true;
      expect(
        await f.service.uploadFile(actor, {
          leaseId: held.leaseId,
          chooserId,
          fileName: "rejected.txt",
          bytes: new TextEncoder().encode("nope"),
        }),
      ).toEqual({ status: "refused", reason: "lease-ended" });
      expect(refusedPath !== undefined && existsSync(refusedPath)).toBe(false);

      // Accepted upload stays staged past chooser selection and hand-back so the
      // page's form can still submit it, then is removed when the context ends.
      shouldRefuse = false;
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
      expect(seenPath !== undefined && existsSync(seenPath)).toBe(true);

      expect(await f.service.execute(actor, { kind: "hand-back", leaseId: held.leaseId })).toEqual({
        status: "released",
      });
      expect(seenPath !== undefined && existsSync(seenPath)).toBe(true);

      await f.service.pageEnded(contextOne);
      expect(seenPath !== undefined && existsSync(seenPath)).toBe(false);
    } finally {
      await f.service.close();
    }
  });

  it("refuses concurrent retries carrying the same sequence number without duplicating native input", async () => {
    const releaseDispatch = Promise.withResolvers<void>();
    const input = vi.fn(async () => {
      await releaseDispatch.promise;
      return { status: "input" as const, effect: "completed" as const };
    });
    const f = makeFixture({ input });
    try {
      const actor = makeActor();
      const held = await f.service.takeOver(actor, threadOne);
      if (held.status !== "held") throw new Error("Expected held lease");

      const first = f.service.execute(actor, {
        kind: "input",
        leaseId: held.leaseId,
        sequence: 1,
        events: [{ kind: "text", text: "once" }],
      });
      const duplicate = f.service.execute(actor, {
        kind: "input",
        leaseId: held.leaseId,
        sequence: 1,
        events: [{ kind: "text", text: "once" }],
      });

      expect(await duplicate).toEqual({
        status: "refused",
        reason: "stale-frame",
        effect: "none",
      });
      releaseDispatch.resolve();
      expect(await first).toEqual({
        status: "input",
        lastAcceptedSequence: 1,
        effect: "completed",
      });
      expect(input).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.close();
    }
  });

  it("ends an open Browser stream immediately when the paired session expires or is invalidated by digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octant-paired-session-check-"));
    const connection = openSqlite(join(dir, "octant.db"));
    try {
      const createdIso = "2026-11-20T10:00:00.000Z";
      let nowMs = Date.parse(createdIso);
      applyMigrations(connection, MIGRATIONS, () => new Date(nowMs).toISOString());

      const hostId = "10000000-0000-4000-8000-000000000001";
      const deviceId = "20000000-0000-4000-8000-000000000002";
      const sessionId = "30000000-0000-4000-8000-000000000003";
      const sessionDigest = createHash("sha256").update(sessionId, "utf8").digest("hex");

      connection
        .prepare(
          `INSERT INTO remote_device_projection (
             device_id, host_id, device_key_fingerprint, device_public_key,
             device_label, origin, protocol_floor, credential_generation,
             created_at, expires_at, last_seen_at, state, revoked_at, revoked_reason
           ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'active', NULL, NULL)`,
        )
        .run(
          deviceId,
          hostId,
          "b".repeat(64),
          "pub-key",
          "My iPhone",
          "https://octant.example",
          createdIso,
          "2027-11-20T10:00:00.000Z",
          createdIso,
        );
      connection
        .prepare(
          `INSERT INTO remote_security_audit_projection (
             event_kind, host_id, device_id, protocol_version, credential_generation,
             source_class, result_category, reason_code, correlation_id, occurred_at
           ) VALUES ('device-approved', ?, ?, 1, 1, 'lan-private', 'ok', 'user-approved', ?, ?)`,
        )
        .run(hostId, deviceId, "40000000-0000-4000-8000-000000000004", createdIso);
      connection
        .prepare(
          `INSERT INTO remote_session_store (
             session_id_digest, host_id, device_id, credential_generation, origin,
             protocol_version, capability_digest, issued_at, last_seen_at,
             idle_expires_at, absolute_expires_at, csrf_digest, state
           ) VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?, ?, ?, ?, 'active')`,
        )
        .run(
          sessionDigest,
          hostId,
          deviceId,
          "https://octant.example",
          "c".repeat(64),
          nowMs,
          nowMs,
          nowMs + 30_000,
          nowMs + 120_000,
          "d".repeat(64),
        );

      const principal = { deviceId, sessionId, credentialGeneration: 1 };
      expect(isPairedDeviceSessionCurrent(connection, principal, nowMs)).toBe(true);

      // Idle session expiry ends an active stream on the next frame tick.
      const f = makeFixture();
      try {
        const actor = makeActor({
          deviceId,
          sessionId,
          current: () => isPairedDeviceSessionCurrent(connection, principal, nowMs),
        });
        const held = await f.service.takeOver(actor, threadOne);
        if (held.status !== "held") throw new Error("Expected held lease");
        const streamRes = f.service.openStream(actor, held.leaseId);
        if (streamRes.status !== "stream") throw new Error("Expected stream");
        const eventsPromise = readNdjsonLines(streamRes.stream, 2);
        await vi.waitFor(() => expect(vi.mocked(f.host.frame)).toHaveBeenCalled());

        nowMs += 35_000;
        expect(isPairedDeviceSessionCurrent(connection, principal, nowMs)).toBe(false);
        const events = await eventsPromise;
        expect(events.some((event) => event.kind === "ended" && event.reason === "revoked")).toBe(
          true,
        );
      } finally {
        await f.service.close();
      }

      // Reset clock within expiry and verify digest-keyed invalidation revokes the session.
      nowMs = Date.parse(createdIso) + 1_000;
      expect(isPairedDeviceSessionCurrent(connection, principal, nowMs)).toBe(true);
      connection
        .prepare(
          `INSERT INTO remote_session_invalidation_projection (
             session_id_digest, host_id, device_id, credential_generation,
             state, invalidated_at, reason_code, receipt_id
           ) VALUES (?, ?, ?, 1, 'invalidated', ?, 'user-logout', ?)`,
        )
        .run(
          sessionDigest,
          hostId,
          deviceId,
          new Date(nowMs).toISOString(),
          "50000000-0000-4000-8000-000000000005",
        );
      expect(isPairedDeviceSessionCurrent(connection, principal, nowMs)).toBe(false);
    } finally {
      connection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an open Browser stream alive across a forward wall-clock jump when sharing the gateway's monotonic clock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octant-paired-monotonic-clock-"));
    const connection = openSqlite(join(dir, "octant.db"));
    try {
      const createdIso = "2026-11-20T10:00:00.000Z";
      let wallMs = Date.parse(createdIso);
      const steadyMs = 10_000;
      applyMigrations(connection, MIGRATIONS, () => new Date(wallMs).toISOString());

      const hostId = "10000000-0000-4000-8000-000000000001";
      const deviceId = "20000000-0000-4000-8000-000000000002";
      const sessionId = "30000000-0000-4000-8000-000000000003";
      const sessionDigest = createHash("sha256").update(sessionId, "utf8").digest("hex");

      connection
        .prepare(
          `INSERT INTO remote_device_projection (
             device_id, host_id, device_key_fingerprint, device_public_key,
             device_label, origin, protocol_floor, credential_generation,
             created_at, expires_at, last_seen_at, state, revoked_at, revoked_reason
           ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'active', NULL, NULL)`,
        )
        .run(
          deviceId,
          hostId,
          "b".repeat(64),
          "pub-key",
          "My iPhone",
          "https://octant.example",
          createdIso,
          "2027-11-20T10:00:00.000Z",
          createdIso,
        );
      connection
        .prepare(
          `INSERT INTO remote_security_audit_projection (
             event_kind, host_id, device_id, protocol_version, credential_generation,
             source_class, result_category, reason_code, correlation_id, occurred_at
           ) VALUES ('device-approved', ?, ?, 1, 1, 'lan-private', 'ok', 'user-approved', ?, ?)`,
        )
        .run(hostId, deviceId, "40000000-0000-4000-8000-000000000004", createdIso);
      connection
        .prepare(
          `INSERT INTO remote_session_store (
             session_id_digest, host_id, device_id, credential_generation, origin,
             protocol_version, capability_digest, issued_at, last_seen_at,
             idle_expires_at, absolute_expires_at, csrf_digest, state
           ) VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?, ?, ?, ?, 'active')`,
        )
        .run(
          sessionDigest,
          hostId,
          deviceId,
          "https://octant.example",
          "c".repeat(64),
          wallMs,
          wallMs,
          wallMs + 15 * 60_000,
          wallMs + 60 * 60_000,
          "d".repeat(64),
        );

      const monotonicClock = new MonotonicRemoteClock({
        connection,
        hostId,
        wallClock: () => wallMs,
        monotonicSource: () => steadyMs,
      });
      const guardedNow = monotonicClock.now();
      const proofService = new RemoteRequestProofService(connection, {
        now: guardedNow,
        resolveNegotiation: () => undefined,
      });
      const principal = { deviceId, sessionId, credentialGeneration: 1 };

      // Establish baseline observation on the shared monotonic clock.
      expect(proofService.describeSession(sessionId)).toBeDefined();
      expect(isPairedDeviceSessionCurrent(connection, principal, guardedNow())).toBe(true);

      const f = makeFixture();
      try {
        const actor = makeActor({
          deviceId,
          sessionId,
          current: () => isPairedDeviceSessionCurrent(connection, principal, guardedNow()),
        });
        const held = await f.service.takeOver(actor, threadOne);
        if (held.status !== "held") throw new Error("Expected held lease");
        const streamRes = f.service.openStream(actor, held.leaseId);
        if (streamRes.status !== "stream") throw new Error("Expected stream");

        // Jump wall clock 20 minutes forward (past the 15-minute idle_expires_at)
        // without advancing steady monotonic time.
        wallMs += 20 * 60_000;
        expect(isPairedDeviceSessionCurrent(connection, principal, wallMs)).toBe(false);
        expect(proofService.describeSession(sessionId)).toBeDefined();
        expect(isPairedDeviceSessionCurrent(connection, principal, guardedNow())).toBe(true);

        // Stream stays alive and delivers multiple frames instead of ending prematurely.
        const events = await readNdjsonLines(streamRes.stream, 2);
        expect(events.map((event) => event.kind)).toEqual(["frame", "frame"]);
      } finally {
        await f.service.close();
      }
    } finally {
      connection.close();
      rmSync(dir, { recursive: true, force: true });
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
