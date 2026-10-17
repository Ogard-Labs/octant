import { describe, expect, it } from "vitest";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import {
  ExtensionActivationService,
  LOCAL_EXTENSION_ACTIVATION_POLICY,
  createLocalExtensionActivationPolicy,
} from "./extensionActivationService";
import { createPersistedExtensionActivationPolicy } from "./persistedExtensionActivationPolicy";

const extensionId = "46000000-0000-4000-8000-000000000001";
const packageId = "46000000-0000-4000-8000-000000000002";
const projectId = "46000000-0000-4000-8000-000000000003";
const digest = `sha256:${"a".repeat(64)}`;
const scope = {
  hostId: "local",
  mode: "code",
  projectId,
  threadId: "46000000-0000-4000-8000-000000000004",
  providerFamily: "ollama",
} as const;

function snapshot(): ExtensionSnapshot {
  return {
    sequence: 9 as never,
    snapshotAt: "2026-07-28T12:00:00.000Z" as never,
    packages: [
      {
        extensionId,
        packageId,
        stateVersion: 4,
        version: "1.0.0",
        digest,
        source: { kind: "catalog", catalogId: "octant", entryId: "fixture" },
        compatibility: {
          platforms: ["macos"],
          modes: ["code"],
          providerFamilies: ["ollama"],
        },
        activation: activation(false),
        components: [
          {
            component: {
              id: "instructions",
              kind: "skill-instructions",
              displayName: "Instructions",
              declaredCapabilities: ["instructions"],
              contentReference: "content:instructions",
            },
            activation: activation(true),
            effectiveState: { kind: "effective" },
          },
        ],
        diagnostics: [],
      },
    ],
    collisions: [
      {
        name: "review",
        candidates: [
          `catalog:a:review:sha256:${"b".repeat(64)}`,
          `catalog:b:review:sha256:${"c".repeat(64)}`,
        ],
      },
    ],
  } as never;
}

function activation(componentDesired: boolean) {
  return {
    installed: true,
    trusted: true,
    pluginDesired: true,
    componentDesired,
    compatible: true,
    policyAllowed: true,
    quarantined: false,
    draining: false,
    broken: false,
    unavailable: false,
    interrupted: false,
    waiting: false,
  };
}

describe("authoritative scoped extension activation", () => {
  it("fails closed for unresolved Project/thread authority and non-local hosts", () => {
    const packageState = snapshot().packages[0]!;
    const component = packageState.components[0]!.component;
    expect(
      LOCAL_EXTENSION_ACTIVATION_POLICY.resolve({
        scope: scope as never,
        packageState,
        component,
      }),
    ).toMatchObject({ projectAllowed: false, threadAllowed: false });
    const resolved = createLocalExtensionActivationPolicy({
      project: () => ({ allowed: true, revision: 2 }),
      thread: () => ({ allowed: true, revision: 3 }),
    }).resolve({
      scope: { ...scope, hostId: "remote" } as never,
      packageState,
      component,
    });
    expect(resolved).toMatchObject({
      revision: 0,
      projectRevision: 2,
      threadRevision: 3,
      hostAllowed: false,
    });
  });

  it("reports deterministic effective state, offline catalog, collisions, and zero context", () => {
    const service = new ExtensionActivationService({
      policy: { resolve: () => allowedPolicy(1) },
      catalogStatus: () => "offline",
    });

    const result = service.resolve(snapshot(), { scope } as never);

    expect(result).toMatchObject({
      sequence: 9,
      scope,
      catalogStatus: "offline",
      stale: false,
      collisions: [{ name: "review" }],
      packages: [
        {
          stateVersion: 4,
          components: [
            {
              policy: { revision: 1 },
              effectiveState: { kind: "effective" },
              contextContribution: { kind: "zero", reason: "not-selected" },
            },
          ],
        },
      ],
    });
    expect(result.catalogEpoch).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("preserves the catalog epoch across unrelated global journal sequence drift", () => {
    const service = new ExtensionActivationService({
      policy: { resolve: () => allowedPolicy(1) },
      catalogStatus: () => "available",
    });
    const current = service.resolve(snapshot(), { scope } as never);
    const unrelatedEventSnapshot = { ...snapshot(), sequence: 10 as never };

    const afterUnrelatedEvent = service.resolve(unrelatedEventSnapshot, {
      scope,
      expectedCatalogEpoch: current.catalogEpoch,
    } as never);

    expect(afterUnrelatedEvent.catalogEpoch).toBe(current.catalogEpoch);
    expect(afterUnrelatedEvent.stale).toBe(false);
    expect(afterUnrelatedEvent.packages[0]?.components[0]?.effectiveState).toEqual({
      kind: "effective",
    });
  });

  it("keeps installed verified content admissible when the marketplace goes offline", () => {
    let catalogStatus: "available" | "offline" = "available";
    const service = new ExtensionActivationService({
      policy: { resolve: () => allowedPolicy(1) },
      catalogStatus: () => catalogStatus,
    });
    const online = service.resolve(snapshot(), { scope } as never);

    catalogStatus = "offline";
    const offline = service.resolve(snapshot(), {
      scope,
      expectedCatalogEpoch: online.catalogEpoch,
    } as never);

    expect(offline.catalogStatus).toBe("offline");
    expect(offline.catalogEpoch).toBe(online.catalogEpoch);
    expect(offline.stale).toBe(false);
    expect(offline.packages[0]?.components[0]?.effectiveState).toEqual({ kind: "effective" });
  });

  it("keeps the catalog epoch when only the Project or thread version moves", () => {
    let projectRevision = 4;
    let threadRevision = 8;
    const service = new ExtensionActivationService({
      policy: createLocalExtensionActivationPolicy({
        project: () => ({ allowed: true, revision: projectRevision }),
        thread: () => ({ allowed: true, revision: threadRevision }),
      }),
      catalogStatus: () => "available",
    });
    const baseline = service.resolve(snapshot(), { scope } as never);

    projectRevision = 5;
    threadRevision = 9;
    const afterVersionMoves = service.resolve(snapshot(), {
      scope,
      expectedCatalogEpoch: baseline.catalogEpoch,
    } as never);

    expect(afterVersionMoves.catalogEpoch).toBe(baseline.catalogEpoch);
    expect(afterVersionMoves.stale).toBe(false);
    expect(afterVersionMoves.packages[0]?.components[0]?.effectiveState).toEqual({
      kind: "effective",
    });
  });

  describe.each(["chat", "work", "code"] as const)(
    "with the host's persisted %s records",
    (mode) => {
      const modeScope = { ...scope, mode } as const;
      const modeSnapshot = (): ExtensionSnapshot => {
        const base = snapshot();
        const [packageState] = base.packages;
        return {
          ...base,
          packages: [
            {
              ...packageState!,
              compatibility: { ...packageState!.compatibility, modes: [mode] },
            },
          ],
        } as never;
      };
      const records = (state: {
        project: { lifecycle: string; type: string; version: number } | undefined;
        thread: { lifecycle: string; projectId: string | undefined; version: number } | undefined;
      }) =>
        createPersistedExtensionActivationPolicy({
          readProject: () => state.project as never,
          readChatThread: () => state.thread as never,
          readWorkThread: () => state.thread as never,
          readCodeThread: () => state.thread as never,
        });
      const activeState = () => ({
        project: { lifecycle: "active", type: mode, version: 3 },
        thread: { lifecycle: "active", projectId: projectId as string | undefined, version: 7 },
      });

      it("survives any number of thread and Project updates", () => {
        const state = activeState();
        const service = new ExtensionActivationService({
          policy: records(state),
          catalogStatus: () => "available",
        });
        const resolved = service.resolve(modeSnapshot(), { scope: modeScope } as never);
        expect(resolved.packages[0]?.components[0]?.effectiveState).toEqual({ kind: "effective" });

        state.thread.version += 2;
        state.project.version += 1;
        const afterUpdates = service.resolve(modeSnapshot(), {
          scope: modeScope,
          expectedCatalogEpoch: resolved.catalogEpoch,
        } as never);

        expect(afterUpdates.stale).toBe(false);
        expect(afterUpdates.packages[0]?.components[0]?.effectiveState).toEqual({
          kind: "effective",
        });
      });

      it.each([
        [
          "the thread is archived",
          (state: ReturnType<typeof activeState>) => {
            state.thread.lifecycle = "archived";
          },
        ],
        [
          "the thread moves to another Project",
          (state: ReturnType<typeof activeState>) => {
            state.thread.projectId = "46000000-0000-4000-8000-0000000000ff";
          },
        ],
        [
          "the thread is removed",
          (state: ReturnType<typeof activeState>) => {
            state.thread = undefined as never;
          },
        ],
        [
          "the Project is archived",
          (state: ReturnType<typeof activeState>) => {
            state.project.lifecycle = "archived";
          },
        ],
        [
          "the Project is removed",
          (state: ReturnType<typeof activeState>) => {
            state.project = undefined as never;
          },
        ],
      ] as const)("blocks a selection resolved before %s", (_change, change) => {
        const state = activeState();
        const service = new ExtensionActivationService({
          policy: records(state),
          catalogStatus: () => "available",
        });
        const resolved = service.resolve(modeSnapshot(), { scope: modeScope } as never);

        change(state);
        const after = service.resolve(modeSnapshot(), {
          scope: modeScope,
          expectedCatalogEpoch: resolved.catalogEpoch,
        } as never);

        expect(after.stale).toBe(true);
        expect(after.catalogEpoch).not.toBe(resolved.catalogEpoch);
        // The scope's own refusal outranks the stale marker in the ladder.
        expect(after.packages[0]?.components[0]?.effectiveState).toMatchObject({
          kind: "blocked",
          reason: expect.stringMatching(/-prohibited$/),
        });
      });

      it("blocks a selection resolved in another mode", () => {
        const state = activeState();
        const service = new ExtensionActivationService({
          policy: records(state),
          catalogStatus: () => "available",
        });
        const resolved = service.resolve(modeSnapshot(), { scope: modeScope } as never);

        const inWork = service.resolve(modeSnapshot(), {
          scope: { ...modeScope, mode: mode === "chat" ? "work" : "chat" },
          expectedCatalogEpoch: resolved.catalogEpoch,
        } as never);

        expect(inWork.stale).toBe(true);
        expect(inWork.packages[0]?.components[0]?.effectiveState.kind).toBe("blocked");
      });

      it.each([
        [
          "the plugin is disabled",
          (base: ExtensionSnapshot) =>
            withPackage(base, { activation: { ...activation(false), pluginDesired: false } }),
        ],
        [
          "the component is disabled",
          (base: ExtensionSnapshot) => withComponentActivation(base, activation(false)),
        ],
        [
          "the plugin is updated",
          (base: ExtensionSnapshot) =>
            withPackage(base, {
              version: "1.0.1",
              digest: `sha256:${"d".repeat(64)}`,
              stateVersion: 5,
            }),
        ],
        ["the plugin is uninstalled", (base: ExtensionSnapshot) => ({ ...base, packages: [] })],
      ] as const)("blocks a selection resolved before %s", (_change, change) => {
        const service = new ExtensionActivationService({
          policy: records(activeState()),
          catalogStatus: () => "available",
        });
        const resolved = service.resolve(modeSnapshot(), { scope: modeScope } as never);

        const after = service.resolve(change(modeSnapshot()), {
          scope: modeScope,
          expectedCatalogEpoch: resolved.catalogEpoch,
        } as never);

        expect(after.stale).toBe(true);
        expect(after.catalogEpoch).not.toBe(resolved.catalogEpoch);
      });
    },
  );

  it.each([
    ["chat", "app", ["apps"]],
    ["chat", "mcp-tool", ["mcp", "shell"]],
    ["work", "hook", ["hooks"]],
    ["work", "mcp-tool", ["mcp", "shell"]],
  ] as const)(
    "mode-prohibits unsafe %s components even when package compatibility includes the mode",
    (mode, kind, declaredCapabilities) => {
      const packageState = snapshot().packages[0]!;
      const component = {
        ...packageState.components[0]!.component,
        kind,
        declaredCapabilities,
      } as never;
      const policy = createLocalExtensionActivationPolicy({
        project: () => ({ allowed: true, revision: 1 }),
        thread: () => ({ allowed: true, revision: 1 }),
      });

      expect(
        policy.resolve({
          scope: { ...scope, mode } as never,
          packageState: {
            ...packageState,
            compatibility: { ...packageState.compatibility, modes: [mode] },
          } as never,
          component,
        }).modeAllowed,
      ).toBe(false);
    },
  );

  it("invalidates every component when policy or scope drifts from the expected epoch", () => {
    let revision = 1;
    const service = new ExtensionActivationService({
      policy: { resolve: () => allowedPolicy(revision) },
      catalogStatus: () => "available",
    });
    const current = service.resolve(snapshot(), { scope } as never);

    revision = 2;
    const policyDrift = service.resolve(snapshot(), {
      scope,
      expectedCatalogEpoch: current.catalogEpoch,
    } as never);
    expect(policyDrift).toMatchObject({
      stale: true,
      packages: [
        {
          components: [
            {
              effectiveState: { kind: "blocked", reason: "stale-catalog-epoch" },
              contextContribution: { kind: "zero", reason: "stale-catalog-epoch" },
            },
          ],
        },
      ],
    });

    revision = 1;
    for (const driftedScope of [
      { ...scope, hostId: "remote" },
      { ...scope, mode: "chat" },
      { ...scope, projectId: null },
      { ...scope, threadId: null },
    ] as const) {
      const scopeDrift = service.resolve(snapshot(), {
        scope: driftedScope,
        expectedCatalogEpoch: current.catalogEpoch,
      } as never);
      expect(scopeDrift.packages[0]?.components[0]?.effectiveState).toEqual({
        kind: "blocked",
        reason: "stale-catalog-epoch",
      });
    }
  });

  it("re-evaluates environment compatibility and includes it in epoch invalidation", () => {
    let compatible = true;
    const service = new ExtensionActivationService({
      policy: { resolve: () => allowedPolicy(1) },
      catalogStatus: () => "available",
      compatibility: () => compatible,
    });
    const current = service.resolve(snapshot(), { scope } as never);
    expect(current.packages[0]?.components[0]?.effectiveState).toEqual({ kind: "effective" });

    compatible = false;
    const stale = service.resolve(snapshot(), {
      scope,
      expectedCatalogEpoch: current.catalogEpoch,
    } as never);
    expect(stale.packages[0]?.components[0]?.effectiveState).toEqual({
      kind: "blocked",
      reason: "stale-catalog-epoch",
    });
    expect(
      service.resolve(snapshot(), { scope } as never).packages[0]?.components[0],
    ).toMatchObject({
      activation: { compatible: false },
      effectiveState: { kind: "blocked", reason: "incompatible" },
    });
  });

  it.each([
    ["host-prohibited", { hostAllowed: false }],
    ["mode-prohibited", { modeAllowed: false }],
    ["project-prohibited", { projectAllowed: false }],
    ["thread-prohibited", { threadAllowed: false }],
  ] as const)("reports scoped policy block %s", (reason, patch) => {
    const service = new ExtensionActivationService({
      policy: { resolve: () => ({ ...allowedPolicy(1), ...patch }) },
      catalogStatus: () => "available",
    });
    expect(
      service.resolve(snapshot(), { scope } as never).packages[0]?.components[0],
    ).toMatchObject({
      effectiveState: { kind: "blocked", reason },
      contextContribution: { kind: "zero", reason },
    });
  });
});

function withPackage(base: ExtensionSnapshot, patch: Record<string, unknown>): ExtensionSnapshot {
  const [packageState] = base.packages;
  return { ...base, packages: [{ ...packageState!, ...patch }] } as never;
}

function withComponentActivation(
  base: ExtensionSnapshot,
  componentActivation: ReturnType<typeof activation>,
): ExtensionSnapshot {
  const [packageState] = base.packages;
  const [componentState] = packageState!.components;
  return withPackage(base, {
    components: [{ ...componentState!, activation: componentActivation }],
  });
}

function allowedPolicy(revision: number) {
  return {
    revision,
    projectRevision: 0,
    threadRevision: 0,
    hostAllowed: true,
    modeAllowed: true,
    projectAllowed: true,
    threadAllowed: true,
    policyAllowed: true,
  };
}
