import { MAX_PROVIDER_TOOLS, type ChatThread } from "@octant/contracts";
import type {
  ExtensionEffectiveSnapshot,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import type { ExtensionEffectiveState } from "@octant/contracts/extensions";
import { describe, expect, it, vi } from "vitest";
import {
  createExtensionChatResolver,
  createStoredExtensionMaterialLoader,
  UNAVAILABLE_EXTENSION_TOOL_EXECUTION,
  type ExtensionMaterialLoaderPort,
} from "./extensionChatResolver";

const extensionId = "94000000-0000-4000-8000-000000000001";
const packageId = "94000000-0000-4000-8000-000000000002";
const providerInstanceId = "94000000-0000-4000-8000-000000000003";
const threadId = "94000000-0000-4000-8000-000000000004";
const digest = `sha256:${"a".repeat(64)}`;
const catalogEpoch = `sha256:${"b".repeat(64)}`;

function thread(): ChatThread {
  return {
    id: threadId,
    title: "Extensions",
    lifecycle: "active",
    providerInstanceId,
    modelId: "generic-model",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be helpful.",
    version: 1,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  } as never;
}

function snapshots(
  effectiveState: ExtensionEffectiveState,
  componentKind:
    | "skill-instructions"
    | "mcp-tool"
    | "mcp-prompt"
    | "mcp-resource" = "skill-instructions",
): {
  readonly snapshot: ExtensionSnapshot;
  readonly effective: ExtensionEffectiveSnapshot;
} {
  const packageState = {
    extensionId,
    packageId,
    slug: "review-tools",
    displayName: "Review tools",
    stateVersion: 4,
    version: "1.0.0",
    digest,
    source: { kind: "catalog", catalogId: "octant", entryId: "review-tools" },
    compatibility: { platforms: ["macos"], modes: ["chat"], providerFamilies: [] },
    activation: activation(true),
    components: [
      {
        component: {
          id: "review",
          kind: componentKind,
          displayName: "Review guidance",
          declaredCapabilities: componentKind === "skill-instructions" ? ["instructions"] : ["mcp"],
          ...(componentKind === "skill-instructions" ? { contentReference: "content:review" } : {}),
        },
        activation: activation(true),
        effectiveState,
      },
    ],
    diagnostics: [],
  } as const;
  const snapshot = {
    sequence: 8,
    snapshotAt: "2026-07-29T00:00:00.000Z",
    packages: [packageState],
    skills: [],
    collisions: [],
  } as unknown as ExtensionSnapshot;
  const effective = {
    ...snapshot,
    scope: {
      hostId: "local",
      mode: "chat",
      projectId: null,
      threadId,
      providerFamily: "openai-compatible",
    },
    catalogEpoch,
    catalogStatus: "available",
    stale: false,
    packages: [
      {
        ...packageState,
        components: packageState.components.map((component) => ({
          ...component,
          policy: {
            revision: 1,
            projectRevision: 1,
            threadRevision: 1,
            hostAllowed: true,
            modeAllowed: true,
            projectAllowed: true,
            threadAllowed: true,
            policyAllowed: true,
          },
          contextContribution: {
            kind: "zero" as const,
            reason:
              effectiveState.kind === "effective"
                ? ("not-selected" as const)
                : effectiveState.reason,
          },
        })),
      },
    ],
  } as unknown as ExtensionEffectiveSnapshot;
  return { snapshot, effective };
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

function selection(componentId = "review") {
  return {
    kind: "plugin" as const,
    extensionId: extensionId as never,
    packageId: packageId as never,
    componentId: componentId as never,
    packageVersion: "1.0.0" as never,
    packageDigest: digest as never,
    catalogEpoch: catalogEpoch as never,
    origin: { kind: "draft" as const, reference: "draft-1" },
  };
}

describe("authoritative extension Chat resolver", () => {
  it("composes selected verified material from the effective projection", async () => {
    const state = snapshots({ kind: "effective" });
    const load = vi.fn<ExtensionMaterialLoaderPort["load"]>(async () => ({
      context: { kind: "instructions", text: "Use verified review guidance." },
      tools: [],
    }));
    const resolver = createExtensionChatResolver({
      snapshot: () => state.snapshot,
      resolveEffectiveState: () => state.effective,
      providerFamily: () => "openai-compatible" as never,
      materialLoader: { load },
      toolExecution: { availability: () => "available", execute: async () => ({ result: {} }) },
    });

    const result = await resolver({ phase: "send", thread: thread(), selections: [selection()] });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.providerContext).toEqual({
      kind: "instructions",
      text: "Use verified review guidance.",
    });
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          source: expect.objectContaining({ packageId, componentId: "review" }),
        }),
        effectiveSnapshot: state.effective,
      }),
    );
  });

  it("reconciles executable sessions in the requesting thread authority scope", async () => {
    const state = snapshots({ kind: "effective" });
    const reconcileEffectiveState = vi.fn(async () => undefined);
    const resolver = createExtensionChatResolver({
      snapshot: () => state.snapshot,
      resolveEffectiveState: () => state.effective,
      reconcileEffectiveState,
      providerFamily: () => "openai-compatible" as never,
      materialLoader: { load: async () => ({ tools: [] }) },
      toolExecution: { availability: () => "available", execute: async () => ({ result: {} }) },
    });

    await resolver({ phase: "send", thread: thread(), selections: [selection()] });

    expect(reconcileEffectiveState).toHaveBeenCalledOnce();
    expect(reconcileEffectiveState).toHaveBeenCalledWith(state.effective);
  });

  it("uses the post-reconcile projection before loading selected MCP material", async () => {
    const state = snapshots({ kind: "effective" });
    const unavailable = snapshots({ kind: "blocked", reason: "unavailable" }).effective;
    const load = vi.fn<ExtensionMaterialLoaderPort["load"]>(async () => ({ tools: [] }));
    const resolver = createExtensionChatResolver({
      snapshot: () => state.snapshot,
      resolveEffectiveState: () => state.effective,
      reconcileEffectiveState: async () => unavailable,
      providerFamily: () => "openai-compatible" as never,
      materialLoader: { load },
      toolExecution: { availability: () => "available", execute: async () => ({ result: {} }) },
    });

    await expect(
      resolver({ phase: "send", thread: thread(), selections: [selection()] }),
    ).rejects.toThrow(/unavailable/i);
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects execution of a tool that was not selected for the turn", async () => {
    const state = snapshots({ kind: "effective" });
    const execute = vi.fn(async () => ({ result: { ok: true } }));
    const resolver = createExtensionChatResolver({
      snapshot: () => state.snapshot,
      resolveEffectiveState: () => state.effective,
      providerFamily: () => "openai-compatible" as never,
      materialLoader: {
        load: async () => ({
          tools: [{ name: "selected_tool", inputSchema: { type: "object" } }],
        }),
      },
      toolExecution: { availability: () => "available", execute },
    });
    const windowId = "44000000-0000-4000-8000-000000000020" as never;
    const selectedThread = thread();
    const result = await resolver({
      phase: "send",
      thread: selectedThread,
      selections: [selection()],
      windowId,
    });

    await expect(
      result.toolSet?.execute({ name: "unselected_tool", inputJson: "{}" }),
    ).resolves.toEqual({ result: { error: "extension-tool-not-selected" }, isError: true });
    expect(execute).not.toHaveBeenCalled();
    await result.toolSet?.execute({ name: "selected_tool", inputJson: "{}" });
    expect(execute).toHaveBeenCalledWith({
      windowId,
      thread: selectedThread,
      name: "selected_tool",
      inputJson: "{}",
    });
  });

  it("rejects selected material whose MCP catalogue exceeds provider capacity", async () => {
    const state = snapshots({ kind: "effective" });
    const resolver = createExtensionChatResolver({
      snapshot: () => state.snapshot,
      resolveEffectiveState: () => state.effective,
      providerFamily: () => "openai-compatible" as never,
      materialLoader: {
        load: async () => ({
          tools: Array.from({ length: MAX_PROVIDER_TOOLS + 1 }, (_, index) => ({
            name: `tool_${index}`,
            inputSchema: { type: "object" },
          })),
        }),
      },
      toolExecution: { availability: () => "available", execute: async () => ({ result: {} }) },
    });

    await expect(
      resolver({ phase: "send", thread: thread(), selections: [selection()] }),
    ).rejects.toThrow(/extension-tool-overflow/i);
  });

  it("rejects stored MCP material when no provider-compatible tools remain", async () => {
    const state = snapshots({ kind: "effective" });
    const packageState = state.effective.packages[0]!;
    const componentState = packageState.components[0]!;
    const effectiveSnapshot = {
      ...state.effective,
      packages: [
        {
          ...packageState,
          components: [
            {
              ...componentState,
              component: {
                ...componentState.component,
                kind: "mcp-server",
              },
            },
          ],
        },
      ],
    } as unknown as ExtensionEffectiveSnapshot;
    const snapshot = {
      ...state.snapshot,
      packages: [
        {
          ...state.snapshot.packages[0]!,
          components: [
            {
              ...state.snapshot.packages[0]!.components[0]!,
              component: {
                ...state.snapshot.packages[0]!.components[0]!.component,
                kind: "mcp-server",
              },
            },
          ],
        },
      ],
    } as unknown as ExtensionSnapshot;
    const loader = createStoredExtensionMaterialLoader(
      { readVerifiedComponentText: vi.fn() },
      { mcpToolsForComponent: () => [] },
    );

    await expect(
      loader.load({
        entry: {
          source: {
            kind: "plugin-package",
            extensionId,
            packageId,
            componentId: "review",
            version: "1.0.0",
            digest,
          },
        } as never,
        effectiveSnapshot,
      }),
    ).rejects.toThrow(/no provider-compatible tools/i);

    const resolver = createExtensionChatResolver({
      snapshot: () => snapshot,
      resolveEffectiveState: () => effectiveSnapshot,
      providerFamily: () => "openai-compatible" as never,
      materialLoader: loader,
      toolExecution: UNAVAILABLE_EXTENSION_TOOL_EXECUTION,
    });
    await expect(
      resolver({ phase: "send", thread: thread(), selections: [selection()] }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
  });

  it("loads zero material when the authoritative effective component is blocked", async () => {
    const state = snapshots({ kind: "blocked", reason: "component-disabled" });
    const load = vi.fn<ExtensionMaterialLoaderPort["load"]>();
    const resolver = createExtensionChatResolver({
      snapshot: () => state.snapshot,
      resolveEffectiveState: () => state.effective,
      providerFamily: () => "openai-compatible" as never,
      materialLoader: { load },
      toolExecution: { availability: () => "available", execute: async () => ({ result: {} }) },
    });

    await expect(
      resolver({ phase: "replay", thread: thread(), selections: [selection()] }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(load).not.toHaveBeenCalled();
  });

  it("fails closed instead of advertising executable tools when supervision is unavailable", async () => {
    const state = snapshots({ kind: "effective" });
    const packageComponent = state.snapshot.packages[0]!.components[0]!;
    const effectiveComponent = state.effective.packages[0]!.components[0]!;
    const toolComponent = {
      id: "review",
      kind: "mcp-tool",
      displayName: "Review tool",
      declaredCapabilities: ["mcp"],
    } as const;
    const toolState = {
      snapshot: {
        ...state.snapshot,
        packages: [
          {
            ...state.snapshot.packages[0]!,
            components: [{ ...packageComponent, component: toolComponent }],
          },
        ],
      } as unknown as ExtensionSnapshot,
      effective: {
        ...state.effective,
        packages: [
          {
            ...state.effective.packages[0]!,
            components: [{ ...effectiveComponent, component: toolComponent }],
          },
        ],
      } as unknown as ExtensionEffectiveSnapshot,
    };
    const resolver = createExtensionChatResolver({
      snapshot: () => toolState.snapshot,
      resolveEffectiveState: () => toolState.effective,
      providerFamily: () => "openai-compatible" as never,
      materialLoader: {
        load: async () => ({
          tools: [{ name: "review_project", inputSchema: { type: "object", properties: {} } }],
        }),
      },
      toolExecution: UNAVAILABLE_EXTENSION_TOOL_EXECUTION,
    });

    await expect(
      resolver({ phase: "send", thread: thread(), selections: [selection()] }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
  });

  it.each(["mcp-tool", "mcp-prompt", "mcp-resource"] as const)(
    "never reads or injects unsupported %s source as provider instructions",
    async (componentKind) => {
      const state = snapshots({ kind: "effective" }, componentKind);
      const readVerifiedComponentText = vi.fn(async () => "untrusted component source");
      const resolver = createExtensionChatResolver({
        snapshot: () => state.snapshot,
        resolveEffectiveState: () => state.effective,
        providerFamily: () => "openai-compatible" as never,
        materialLoader: createStoredExtensionMaterialLoader({ readVerifiedComponentText }),
        toolExecution: UNAVAILABLE_EXTENSION_TOOL_EXECUTION,
      });

      await expect(
        resolver({ phase: "send", thread: thread(), selections: [selection()] }),
      ).rejects.toMatchObject({ failure: { category: "unavailable" } });
      expect(readVerifiedComponentText).not.toHaveBeenCalled();
    },
  );

  it("keeps instruction context associated with its capability after a context-free tool", async () => {
    const state = snapshots({ kind: "effective" });
    const packageComponent = state.snapshot.packages[0]!.components[0]!;
    const effectiveComponent = state.effective.packages[0]!.components[0]!;
    const toolComponent = {
      component: {
        id: "execute",
        kind: "mcp-tool",
        displayName: "Review tool",
        declaredCapabilities: ["mcp"],
      },
      activation: activation(true),
      effectiveState: { kind: "effective" as const },
    };
    const mixedState = {
      snapshot: {
        ...state.snapshot,
        packages: [
          {
            ...state.snapshot.packages[0]!,
            components: [toolComponent, packageComponent],
          },
        ],
      } as unknown as ExtensionSnapshot,
      effective: {
        ...state.effective,
        packages: [
          {
            ...state.effective.packages[0]!,
            components: [
              {
                ...toolComponent,
                policy: effectiveComponent.policy,
                contextContribution: effectiveComponent.contextContribution,
              },
              effectiveComponent,
            ],
          },
        ],
      } as unknown as ExtensionEffectiveSnapshot,
    };
    const resolver = createExtensionChatResolver({
      snapshot: () => mixedState.snapshot,
      resolveEffectiveState: () => mixedState.effective,
      providerFamily: () => "openai-compatible" as never,
      materialLoader: {
        load: async ({ entry }) =>
          entry.componentKind === "mcp-tool"
            ? { tools: [] }
            : {
                context: { kind: "instructions", text: "Use verified review guidance." },
                tools: [],
              },
      },
      toolExecution: { availability: () => "available", execute: async () => ({ result: {} }) },
    });

    const result = await resolver({
      phase: "send",
      thread: thread(),
      selections: [selection("execute"), selection("review")],
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).not.toHaveProperty("providerContext");
    expect(result.entries[1]?.providerContext).toEqual({
      kind: "instructions",
      text: "Use verified review guidance.",
    });
  });
});
