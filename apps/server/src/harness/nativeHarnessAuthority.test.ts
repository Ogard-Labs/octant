import { decodeToolActionRequest, nativeHarnessToolCapabilityId } from "@octant/contracts";
import { harnessAsksUnderSessionFullAccess } from "@octant/domain";
import { describe, expect, it } from "vitest";
import { createNativeHarnessAuthority } from "./nativeHarnessAuthority";

const threadId = "00000000-0000-4000-8000-0000000000a1";
const projectId = "00000000-0000-4000-8000-0000000000b1";
const revisionId = "00000000-0000-4000-8000-0000000000c1";
const checkoutId = "00000000-0000-4000-8000-0000000000d1";
const providerInstanceId = "00000000-0000-4000-8000-0000000000e1";

function harnessFor(stored: {
  readonly executionPolicy: "approval-gated" | "full-access";
  readonly permissionPersistence: "current-session" | "project-default";
}) {
  return createNativeHarnessAuthority({
    hostId: "00000000-0000-4000-8000-0000000000aa" as never,
    persistence: {
      readChatThread: () => undefined,
      readProject: () =>
        ({ type: "code", lifecycle: "active", bindingHistory: [{ revisionId }] }) as never,
      readCodeThread: () =>
        ({
          id: threadId,
          lifecycle: "active",
          projectId,
          bindingRevisionId: revisionId,
          checkoutId,
          providerInstanceId,
          ...stored,
        }) as never,
      readProviderInstance: () => ({ enabled: true }) as never,
    },
    workThreads: { read: () => undefined },
    readThreadTaint: () => ({ externalContentIngested: false }) as never,
  });
}

function writeDecision(harness: ReturnType<typeof harnessFor>) {
  const authority = harness.resolve(threadId, "code");
  if (authority === undefined) throw new Error("the fixture thread holds no authority");
  return harness.service.authorize({
    threadId,
    request: decodeToolActionRequest({
      actionId: "00000000-0000-4000-8000-0000000000f1",
      correlationId: "00000000-0000-4000-8000-0000000000f2",
      capability: { id: nativeHarnessToolCapabilityId("write"), version: 1 },
      authority,
      intent: "write notes.md",
      approval: { kind: "not-required" },
    }),
    arguments: { path: "notes.md", content: "hello" },
  });
}

describe("native harness authority", () => {
  it("asks before a write under a session-only Full access, which the access surfaces then say", () => {
    // A session-only grant journals the thread as approval-gated and keeps
    // Full access in the window's memory, so the harness decides from the
    // approval-gated record.
    expect(
      writeDecision(
        harnessFor({ executionPolicy: "approval-gated", permissionPersistence: "current-session" }),
      ),
    ).toMatchObject({ kind: "prompt", reason: "approval-required" });
    expect(
      harnessAsksUnderSessionFullAccess({
        executionPolicy: "full-access",
        permissionPersistence: "current-session",
        driverKind: "openai-compatible",
      }),
    ).toBe(true);
  });

  it("writes without asking once Full access is remembered, which the access surfaces do not qualify", () => {
    expect(
      writeDecision(
        harnessFor({ executionPolicy: "full-access", permissionPersistence: "project-default" }),
      ),
    ).toMatchObject({ kind: "allow" });
    expect(
      harnessAsksUnderSessionFullAccess({
        executionPolicy: "full-access",
        permissionPersistence: "project-default",
        driverKind: "openai-compatible",
      }),
    ).toBe(false);
  });
});
