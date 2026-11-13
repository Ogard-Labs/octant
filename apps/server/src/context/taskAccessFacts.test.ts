import { describe, expect, it, vi } from "vitest";
import {
  decodeContextSubjectRef,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeWindowId,
  type CodeThread,
  type ProviderInstance,
  type ProviderObservedState,
} from "@octant/contracts";
import { createTaskAccessFacts, type TaskAccessSubjectFacts } from "./taskAccessFacts";
import { createHostShield } from "../shield/hostShield";
import type { ProviderDriver } from "@octant/provider-sdk/driver";

const account = decodeProviderInstanceId("82000000-0000-4000-8000-000000000010");
const reviewerAccount = decodeProviderInstanceId("82000000-0000-4000-8000-000000000011");
const model = decodeProviderModelId("main-model");
const subject = decodeContextSubjectRef({
  aggregateType: "code-thread",
  aggregateId: "82000000-0000-4000-8000-000000000002",
});
const windowId = decodeWindowId("82000000-0000-4000-8000-000000000001");
const clock = () => "2026-11-02T21:00:00.000Z";

function fixture() {
  let facts: TaskAccessSubjectFacts | undefined = {
    standing: "active",
    selected: { executionPolicy: "approval-gated", autoApprove: true },
    effective: { executionPolicy: "approval-gated", autoApprove: true },
    providerInstanceId: account,
    modelId: model,
    default: { mode: "auto", scope: "project" },
    outsideContent: true,
  };
  let enabled = true;
  let observed = true;
  let providerReview = false;
  let mixedTools = false;
  let chosen: { providerInstanceId: typeof account; modelId: typeof model } | undefined;
  let chosenUnavailable = false;
  const connect = vi.fn(() => {
    throw new Error("No runtime call may start for facts");
  });
  const thread = {
    id: subject.aggregateId,
    lifecycle: "active",
    projectId: "82000000-0000-4000-8000-000000000020",
    providerInstanceId: account,
    modelId: model,
    executionPolicy: "approval-gated",
    autoApprove: true,
  } as unknown as CodeThread;
  const shield = createHostShield({
    readCodeThread: () => thread,
    providerCapabilities: () => ({
      harnessAutoReview: providerReview ? "supported" : "unsupported",
    }),
    routesApprovals: () => true,
    catalog: () => [{ id: decodeProviderModelId("small-mini"), displayName: "Small mini" }],
    resolveDriver: () => ({ connect }) as unknown as ProviderDriver,
    tainted: () => true,
    watcherLabels: () => [],
    personMessages: () => [],
    scratchRoot: "/tmp/unused-task-facts",
    chosenModel: () => chosen,
    chosenModelUnavailable: () =>
      chosenUnavailable ? "Chosen account is unavailable." : undefined,
    clock,
  });
  const read = createTaskAccessFacts({
    subject: () => facts,
    instance: (id) =>
      ({
        id,
        displayName: id === account ? "Task account" : "Judge account",
        enabled: id === account ? enabled : !chosenUnavailable,
        configuration: { apiKey: "NEVER_EXPOSE_CREDENTIAL" },
      }) as unknown as ProviderInstance,
    observed: () =>
      observed
        ? ({
            readiness: "ready",
            capabilities: {
              approvals: "supported",
              appManagedTools: mixedTools ? "unsupported" : "supported",
              ...(mixedTools ? { appManagedToolsAtFullAccess: "mixed" } : {}),
              nativeWebResearch: "unsupported",
              nativeChildAgents: "unsupported",
            },
            observedAt: clock(),
            message: "/private/credential/store",
            diagnostic: { private: true },
          } as unknown as ProviderObservedState)
        : undefined,
    reviewer: shield.describe,
    clock,
  });
  return {
    read: () => read(subject, windowId),
    setFacts: (next: TaskAccessSubjectFacts | undefined) => {
      facts = next;
    },
    getFacts: () => facts!,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setObserved: (value: boolean) => {
      observed = value;
    },
    setProviderReview: () => {
      providerReview = true;
    },
    setMixedTools: () => {
      mixedTools = true;
    },
    unavailableJudge: () => {
      chosen = {
        providerInstanceId: reviewerAccount,
        modelId: decodeProviderModelId("chosen-judge"),
      };
      chosenUnavailable = true;
    },
    connect,
    shield,
  };
}

describe("host task access facts", () => {
  it("uses the real Shield route/model choice without starting a runtime or leaking diagnostics/credentials", () => {
    const f = fixture();
    const facts = f.read();
    expect(facts).toMatchObject({
      selectedMode: "auto",
      effectiveMode: "auto",
      default: { status: "known", scope: "project", matchesSelected: true },
      reviewer: { kind: "octant-shield", accountId: account, modelId: "small-mini" },
      outsideContent: { read: true, effect: "gates" },
    });
    expect(JSON.stringify(facts)).not.toMatch(/NEVER_EXPOSE|credential\/store|diagnostic|apiKey/);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("names the provider's own reviewer rather than a guessed Shield model", () => {
    const f = fixture();
    f.setProviderReview();
    expect(f.read()?.reviewer).toEqual({
      kind: "provider",
      accountId: account,
      accountName: "Task account",
      availability: "available",
    });
  });
  it("preserves a chosen unavailable Judge account and reports person fallback instead of substituting", () => {
    const f = fixture();
    f.unavailableJudge();
    const facts = f.read();
    expect(facts).toMatchObject({
      effectiveMode: "auto",
      reviewer: {
        kind: "octant-shield",
        accountId: reviewerAccount,
        accountName: "Judge account",
        modelId: "chosen-judge",
        availability: "unavailable",
      },
    });
    expect(facts?.limitations).toContainEqual(
      expect.objectContaining({
        kind: "needs-approval",
        message: expect.stringContaining("another account is not substituted"),
      }),
    );
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(["plan", "approval-gated"] as const)(
    "reports a current %s turn/session ceiling instead of stored Full access",
    (policy) => {
      const f = fixture();
      f.setFacts({
        ...f.getFacts(),
        selected: { executionPolicy: "full-access" },
        effective: { executionPolicy: policy, autoApprove: false },
      });
      expect(f.read()).toMatchObject({
        selectedMode: "full-access",
        effectiveMode: policy === "plan" ? "plan" : "ask-first",
        ceiling: policy === "plan" ? "plan" : "ask-first",
        effectiveContext: "running-turn-or-session",
        reviewer: { kind: "person" },
        outsideContent: { effect: "gates" },
      });
    },
  );
  it("reports Full access as recording outside content without changing the mark", () => {
    const f = fixture();
    f.setFacts({
      ...f.getFacts(),
      selected: { executionPolicy: "full-access" },
      effective: { executionPolicy: "full-access" },
    });
    expect(f.read()).toMatchObject({
      effectiveMode: "full-access",
      reviewer: { kind: "none" },
      outsideContent: { read: true, effect: "recorded" },
    });
    expect(f.getFacts().outsideContent).toBe(true);
  });
  it("labels Octant's tools mixed for a Full access thread whose runtime cannot prove tool exclusivity", () => {
    const f = fixture();
    f.setMixedTools();
    const tools = () =>
      f.read()?.runtime.capabilities.find((capability) => capability.id === "appManagedTools");
    expect(tools()).toEqual({ id: "appManagedTools", support: "unsupported" });
    f.setFacts({
      ...f.getFacts(),
      selected: { executionPolicy: "full-access" },
      effective: { executionPolicy: "full-access" },
    });
    expect(tools()).toEqual({ id: "appManagedTools", support: "mixed" });
    // A running turn held below Full access is not offered the tools.
    f.setFacts({
      ...f.getFacts(),
      selected: { executionPolicy: "full-access" },
      effective: { executionPolicy: "approval-gated", autoApprove: false },
    });
    expect(tools()).toEqual({ id: "appManagedTools", support: "unsupported" });
  });
  it("distinguishes disabled and unknown observations, preserves current default uncertainty", () => {
    const f = fixture();
    f.setEnabled(false);
    f.setObserved(false);
    const { default: _default, ...withoutDefault } = f.getFacts();
    f.setFacts(withoutDefault);
    expect(f.read()).toMatchObject({
      default: { status: "unknown" },
      runtime: { enabled: false, capabilities: [] },
    });
    expect(f.read()?.limitations).toContainEqual(
      expect.objectContaining({ kind: "disabled", recovery: "provider-settings" }),
    );
    f.setEnabled(true);
    expect(f.read()?.limitations).toContainEqual(expect.objectContaining({ kind: "unknown" }));
  });
  it.each(["inactive", "completed"] as const)(
    "does not claim execution on a %s task's stored Full access",
    (standing) => {
      const f = fixture();
      f.setFacts({
        ...f.getFacts(),
        standing,
        selected: { executionPolicy: "full-access" },
        effective: { executionPolicy: "full-access" },
      });
      expect(f.read()?.effectiveMode).toBeUndefined();
      expect(f.read()?.limitations).toContainEqual(
        expect.objectContaining({ kind: "unavailable", recovery: "none" }),
      );
    },
  );
  it("reports an actual turn-standing refusal instead of presenting stored Full access as executable", () => {
    const f = fixture();
    f.setFacts({ ...f.getFacts(), turnRefusal: "binding-changed" });
    expect(f.read()?.effectiveMode).toBeUndefined();
    expect(f.read()?.limitations).toContainEqual(
      expect.objectContaining({
        kind: "unavailable",
        message: expect.stringContaining("Project binding changed"),
      }),
    );
  });
  it("fails closed when current subject standing or effective posture is unavailable", () => {
    const f = fixture();
    const { effective: _effective, ...withoutEffective } = f.getFacts();
    f.setFacts(withoutEffective);
    expect(f.read()).toMatchObject({
      effectiveContext: "unknown",
      reviewer: { kind: "unknown" },
      outsideContent: { effect: "unknown" },
    });
    expect(f.read()?.effectiveMode).toBeUndefined();
    f.setFacts(undefined);
    expect(f.read()).toBeUndefined();
  });
});
