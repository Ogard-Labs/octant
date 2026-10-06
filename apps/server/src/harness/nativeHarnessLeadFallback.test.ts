import {
  decodeNativeHarnessSlotCandidate,
  type NativeHarnessProjectRoutingOverride,
  type NativeHarnessRouteDecision,
  type NativeHarnessRoutingConfiguration,
  type ProviderFailure,
  type ProviderTurnInput,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { NativeHarnessLeadFallbackService } from "./nativeHarnessLeadFallback";
import type { NativeHarnessEndpoint } from "./nativeHarnessEndpointRegistry";
import { NativeHarnessRouter } from "./nativeHarnessRouter";
import type { NativeHarnessTurnScope } from "./nativeHarnessTurnObserver";
import type { NativeHarnessTransportSession } from "./nativeHarnessTransport";

const host = "00000000-0000-4000-8000-0000000000aa";
const candidate = (suffix: string, model: string) =>
  decodeNativeHarnessSlotCandidate({
    hostId: host,
    providerInstanceId: `00000000-0000-4000-8000-0000000000${suffix}`,
    modelId: model,
  });
const lead = candidate("01", "lead-model");
const backup = candidate("02", "backup-model");
const third = candidate("03", "third-model");
const projectA = "00000000-0000-4000-8000-0000000000a1" as never;
const projectB = "00000000-0000-4000-8000-0000000000a2" as never;

const turn = {
  sessionId: "s",
  prompt: "go",
  attachments: [],
  tools: [],
} as never as ProviderTurnInput;
const unavailable: ProviderFailure = {
  category: "unavailable",
  message: "The provider request failed with HTTP 503.",
};

const scopeOf = (projectId?: never): NativeHarnessTurnScope => ({
  threadId: `thread-${String(projectId ?? "none")}`,
  mode: "code",
  providerInstanceId: lead.providerInstanceId,
  modelId: lead.modelId,
  ...(projectId === undefined ? {} : { projectId }),
});

function configuration(
  candidates: ReadonlyArray<ReturnType<typeof candidate>>,
): NativeHarnessRoutingConfiguration {
  return {
    slots: candidates.length === 0 ? [] : [{ id: "default" as never, candidates }],
    jobSlots: [],
  };
}

function fixture(input: {
  readonly host: NativeHarnessRoutingConfiguration;
  readonly overrides?: ReadonlyMap<string, NativeHarnessRoutingConfiguration>;
  readonly endpoints?: ReadonlyMap<string, NativeHarnessEndpoint>;
}) {
  const decisions: Array<{ threadId: string; decision: NativeHarnessRouteDecision }> = [];
  const session = {} as NativeHarnessTransportSession;
  const opened: string[] = [];
  const endpoint = (admit: NativeHarnessEndpoint["admitTurn"] = () => undefined) =>
    ({
      admitTurn: admit,
      open: async (modelId) => {
        opened.push(String(modelId));
        return session;
      },
    }) satisfies NativeHarnessEndpoint;
  const router = new NativeHarnessRouter({
    store: {
      host: () =>
        ({ configuration: input.host, version: 1, updatedAt: "2026-10-06T12:00:00.000Z" }) as never,
      projectOverride: (projectId) => {
        const found = input.overrides?.get(String(projectId));
        return found === undefined
          ? undefined
          : ({ configuration: found } as NativeHarnessProjectRoutingOverride);
      },
    },
    isReady: () => true,
  });
  const service = new NativeHarnessLeadFallbackService({
    router,
    sessions: {
      recordRouteDecision: (threadId, decision) => decisions.push({ threadId, decision }),
    },
    hostId: host,
    endpointFor: (instanceId) =>
      input.endpoints === undefined ? endpoint() : input.endpoints.get(instanceId),
  });
  return { service, router, decisions, session, opened, endpoint };
}

const failedLead = { providerInstanceId: lead.providerInstanceId, modelId: lead.modelId };
const ask = (service: NativeHarnessLeadFallbackService, attempted = [failedLead]) =>
  service.next({ failed: failedLead, attempted, failure: unavailable, turn });

describe("the lead's fallback", () => {
  it("reports the failure to the router and moves to the next model its slot lists", async () => {
    const { service, decisions, session, opened } = fixture({
      host: configuration([lead, backup]),
    });
    service.turnStarted(scopeOf());

    const outcome = await ask(service);

    expect(outcome).toEqual({
      status: "switched",
      target: { providerInstanceId: backup.providerInstanceId, modelId: backup.modelId },
      endpoint: session,
    });
    expect(opened).toEqual(["backup-model"]);
    expect(decisions).toMatchObject([
      {
        threadId: scopeOf().threadId,
        decision: { kind: "failure-fallback", candidate: backup, from: lead },
      },
    ]);
  });

  it("keeps the failed model out of the chain for the next turn's decision too", async () => {
    const { service, router } = fixture({ host: configuration([lead, backup]) });
    service.turnStarted(scopeOf());
    await ask(service);

    expect(router.resolve({ job: "lead" })).toMatchObject({
      kind: "failure-fallback",
      candidate: backup,
      reason: "endpoint-unavailable",
    });
  });

  it("refuses with a typed reason, and journals it, when no slot is configured", async () => {
    const { service, decisions } = fixture({ host: configuration([]) });
    service.turnStarted(scopeOf());

    expect(await ask(service)).toEqual({ status: "none", reason: "slot-empty" });
    expect(decisions).toMatchObject([{ decision: { kind: "unroutable", reason: "slot-empty" } }]);
  });

  it("refuses when the failed model was the only one configured", async () => {
    const { service } = fixture({ host: configuration([lead]) });
    service.turnStarted(scopeOf());

    expect(await ask(service)).toEqual({ status: "none", reason: "no-eligible-candidate" });
  });

  it("never offers a model the turn already ran on", async () => {
    const { service } = fixture({ host: configuration([lead, backup, third]) });
    service.turnStarted(scopeOf());
    const first = await ask(service);
    expect(first).toMatchObject({ status: "switched", target: { modelId: "backup-model" } });

    const second = await service.next({
      failed: { providerInstanceId: backup.providerInstanceId, modelId: backup.modelId },
      attempted: [
        failedLead,
        { providerInstanceId: backup.providerInstanceId, modelId: backup.modelId },
      ],
      failure: unavailable,
      turn,
    });
    expect(second).toMatchObject({ status: "switched", target: { modelId: "third-model" } });
  });

  it("does nothing for a model no running turn is using", async () => {
    const { service, decisions } = fixture({ host: configuration([lead, backup]) });

    expect(await ask(service)).toEqual({ status: "none", reason: "not-routed" });
    expect(decisions).toEqual([]);
  });

  it("refuses a fallback endpoint that is not a harness endpoint or will not take the turn", async () => {
    const missing = fixture({
      host: configuration([lead, backup]),
      endpoints: new Map(),
    });
    missing.service.turnStarted(scopeOf());
    expect(await ask(missing.service)).toEqual({ status: "none", reason: "refused" });

    const base = fixture({ host: configuration([lead, backup]) });
    const refusing = fixture({
      host: configuration([lead, backup]),
      endpoints: new Map([
        [
          String(backup.providerInstanceId),
          base.endpoint(() => ({ category: "unsupported", message: "No image input." })),
        ],
      ]),
    });
    refusing.service.turnStarted(scopeOf());
    expect(await ask(refusing.service)).toEqual({ status: "none", reason: "refused" });
    expect(refusing.opened).toEqual([]);
  });

  it("takes a Project's narrower slot table over the host's", async () => {
    const { service } = fixture({
      host: configuration([lead, backup]),
      overrides: new Map([[String(projectA), configuration([lead, third])]]),
    });
    service.turnStarted(scopeOf(projectA));

    expect(await ask(service)).toMatchObject({
      status: "switched",
      target: { modelId: "third-model" },
    });
  });

  it("does not guess when turns of different Projects would continue on different models", async () => {
    const { service } = fixture({
      host: configuration([lead, backup]),
      overrides: new Map([[String(projectB), configuration([lead, third])]]),
    });
    service.turnStarted(scopeOf(projectA));
    service.turnStarted(scopeOf(projectB));

    expect(await ask(service)).toEqual({ status: "none", reason: "no-other-model" });
  });

  it("counts one failed request once even when several Projects share the slot", async () => {
    const { service, router } = fixture({ host: configuration([lead, backup]) });
    const reported = vi.spyOn(router, "reportFailure");
    service.turnStarted(scopeOf(projectA));
    service.turnStarted(scopeOf(projectB));

    expect(await ask(service)).toMatchObject({ status: "switched" });
    expect(reported).toHaveBeenCalledTimes(1);
  });

  it("stops tracking a turn once it ends", async () => {
    const { service } = fixture({ host: configuration([lead, backup]) });
    service.turnStarted(scopeOf());
    service.turnEnded(scopeOf());

    expect(await ask(service)).toEqual({ status: "none", reason: "not-routed" });
  });
});
