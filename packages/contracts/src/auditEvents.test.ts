import { describe, expect, it } from "vitest";
import {
  AUDIT_EVENT_NAMES,
  decodeAuditActingPrincipal,
  decodeAuditBoundedToken,
  decodeAuditEvent,
  decodeAuditOpaqueReference,
} from "./auditEvents";

const ids = {
  actor: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  action: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  approval: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  correlation: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  device: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  provider: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  thread: "11111111-1111-4111-8111-111111111111",
} as const;

const localActor = { kind: "local-user" as const, actorId: ids.actor };
const remoteActor = {
  kind: "remote-device" as const,
  actorId: ids.actor,
  deviceId: ids.device,
};
const agentActor = {
  kind: "agent" as const,
  actorId: ids.actor,
  providerInstanceId: ids.provider,
  threadId: ids.thread,
};

describe("audit event taxonomy", () => {
  it("enumerates the authority-relevant audit event names", () => {
    expect(AUDIT_EVENT_NAMES).toEqual([
      "tool-call-requested",
      "tool-call-authorized",
      "tool-call-denied",
      "policy-decision-recorded",
      "approval-granted",
      "approval-denied",
      "approval-expired",
      "thread-elevation-changed",
      "authority-transition-recorded",
    ]);
  });

  it.each([
    {
      eventName: "tool-call-requested" as const,
      actor: agentActor,
      payload: {
        actionId: ids.action,
        correlationId: ids.correlation,
        actingPrincipal: { kind: "local-window" as const },
        turnReference: "turn-1",
      },
    },
    {
      eventName: "tool-call-authorized" as const,
      actor: localActor,
      payload: {
        actionId: ids.action,
        correlationId: ids.correlation,
        actingPrincipal: { kind: "local-window" as const },
        resolutionStep: "approval" as const,
      },
    },
    {
      eventName: "tool-call-denied" as const,
      actor: agentActor,
      payload: {
        actionId: ids.action,
        correlationId: ids.correlation,
        actingPrincipal: { kind: "local-window" as const },
        denialReason: "extension-mismatch",
        resolutionStep: "extension-capability" as const,
      },
    },
    {
      eventName: "policy-decision-recorded" as const,
      actor: remoteActor,
      payload: {
        correlationId: ids.correlation,
        actingPrincipal: { kind: "remote-device" as const, deviceId: ids.device },
        decision: "deny" as const,
        denialReason: "local-host-required",
        resolutionStep: "remote-principal" as const,
        policySurface: "remote-access",
      },
    },
    {
      eventName: "approval-granted" as const,
      actor: localActor,
      payload: {
        approvalId: ids.approval,
        approvalClass: "irreversible-shell",
        scope: "action" as const,
        promptingActionId: ids.action,
        correlationId: ids.correlation,
        actingPrincipal: { kind: "local-window" as const },
        ttlMs: 60_000,
      },
    },
    {
      eventName: "approval-denied" as const,
      actor: remoteActor,
      payload: {
        approvalClass: "local-confirmation",
        scope: "action" as const,
        correlationId: ids.correlation,
        actingPrincipal: { kind: "remote-device" as const, deviceId: ids.device },
        denialReason: "remote-cannot-mint-local-receipt",
      },
    },
    {
      eventName: "approval-expired" as const,
      actor: localActor,
      payload: {
        approvalId: ids.approval,
        approvalClass: "session-grant",
        scope: "session" as const,
        correlationId: ids.correlation,
        actingPrincipal: { kind: "local-window" as const },
        expiredAt: "2026-08-12T12:00:00.000Z",
      },
    },
    {
      eventName: "thread-elevation-changed" as const,
      actor: localActor,
      payload: {
        correlationId: ids.correlation,
        actingPrincipal: { kind: "local-window" as const },
        threadReference: "thread-ref-1",
        fromPosture: "plan",
        toPosture: "approval-gated",
        changeKind: "plan-to-execution",
      },
    },
    {
      eventName: "authority-transition-recorded" as const,
      actor: agentActor,
      payload: {
        correlationId: ids.correlation,
        actingPrincipal: { kind: "local-window" as const },
        transitionKind: "child-clamp",
        outcome: "denied" as const,
        denialReason: "authority-widening",
        scopeReference: "parent-run-1",
      },
    },
  ])("decodes $eventName with redacted attribution", (row) => {
    const decoded = decodeAuditEvent({
      eventVersion: 1,
      eventName: row.eventName,
      actor: row.actor,
      occurredAt: "2026-08-12T12:00:00.000Z",
      body: { eventName: row.eventName, payload: row.payload },
    });
    expect(decoded.eventName).toBe(row.eventName);
    expect(decoded.actor.kind).toBe(row.actor.kind);
  });

  it("rejects mismatched eventName/body and excess fields", () => {
    expect(() =>
      decodeAuditEvent({
        eventVersion: 1,
        eventName: "tool-call-denied",
        actor: localActor,
        occurredAt: "2026-08-12T12:00:00.000Z",
        body: {
          eventName: "tool-call-authorized",
          payload: {
            actionId: ids.action,
            correlationId: ids.correlation,
            actingPrincipal: { kind: "local-window" },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAuditEvent({
        eventVersion: 1,
        eventName: "tool-call-denied",
        actor: localActor,
        occurredAt: "2026-08-12T12:00:00.000Z",
        body: {
          eventName: "tool-call-denied",
          payload: {
            actionId: ids.action,
            correlationId: ids.correlation,
            actingPrincipal: { kind: "local-window" },
            denialReason: "extension-mismatch",
            resolutionStep: "extension-capability",
            secretExtra: true,
          },
        },
      }),
    ).toThrow();
  });
});

describe("audit contracts", () => {
  it("accepts opaque references and rejects path-like tokens", () => {
    expect(decodeAuditOpaqueReference("evidence-ref-1")).toBe("evidence-ref-1");
    expect(() => decodeAuditOpaqueReference("/Users/example/secret")).toThrow();
    expect(() => decodeAuditOpaqueReference("C:\\Users\\example")).toThrow();
    expect(() => decodeAuditBoundedToken("Shell Output Dump")).toThrow();
    expect(decodeAuditBoundedToken("authority-widening")).toBe("authority-widening");
  });

  it("decodes server-resolved acting principals only", () => {
    expect(decodeAuditActingPrincipal({ kind: "local-window" })).toEqual({
      kind: "local-window",
    });
    expect(decodeAuditActingPrincipal({ kind: "remote-device", deviceId: ids.device })).toEqual({
      kind: "remote-device",
      deviceId: ids.device,
    });
    expect(() => decodeAuditActingPrincipal({ kind: "local-user" })).toThrow();
  });
});
