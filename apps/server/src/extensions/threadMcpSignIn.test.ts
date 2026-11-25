import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { ExtensionProviderFamily, ExtensionSelection } from "@octant/contracts/extensions";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type { OctantMode } from "@octant/contracts/modes";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  ExtensionActivationService,
  createLocalExtensionActivationPolicy,
} from "./extensionActivationService";
import {
  createThreadMcpSignInReader,
  createThreadMcpSignInThreads,
  type ThreadMcpSignInThread,
} from "./threadMcpSignIn";

const digest = `sha256:${"a".repeat(64)}`;
const threadId = "95000000-0000-4000-8000-000000000004";
const projectId = "95000000-0000-4000-8000-000000000005";
const linear = "95000000-0000-4000-8000-000000000006";
const docs = "95000000-0000-4000-8000-000000000007";
const providerFamily = Schema.decodeUnknownSync(ExtensionProviderFamily)("openai-compatible");

const on = {
  installed: true,
  trusted: true,
  pluginDesired: true,
  componentDesired: true,
  compatible: true,
  policyAllowed: true,
  quarantined: false,
  draining: false,
  broken: false,
  unavailable: false,
  interrupted: false,
  waiting: false,
};

function pack(extensionId: string, slug: string, activation: typeof on = on) {
  return {
    extensionId,
    packageId: extensionId,
    slug,
    displayName: slug,
    stateVersion: 1,
    version: "1.0.0",
    digest,
    source: { kind: "catalog", catalogId: "octant", entryId: slug },
    compatibility: { platforms: ["macos"], modes: ["chat", "work", "code"], providerFamilies: [] },
    activation,
    components: [
      {
        component: {
          id: "mcp",
          kind: "mcp-server",
          displayName: slug,
          declaredCapabilities: ["mcp"],
        },
        activation,
        effectiveState: { kind: "effective" },
      },
    ],
    diagnostics: [],
  };
}

function fixture(
  options: {
    readonly mode?: OctantMode;
    readonly linear?: typeof on;
    readonly pins?: ReadonlyArray<string>;
    readonly thread?: Partial<ThreadMcpSignInThread> | null;
    readonly threadAllowed?: boolean;
    readonly states?: Record<string, "needs-sign-in" | "connected" | "ready">;
  } = {},
) {
  const mode = options.mode ?? "code";
  const snapshot = {
    sequence: 1,
    snapshotAt: "2026-11-25T00:00:00.000Z",
    skills: [],
    collisions: [],
    packages: [pack(linear, "linear", options.linear), pack(docs, "docs")],
  } as unknown as ExtensionSnapshot;
  const activation = new ExtensionActivationService({
    policy: createLocalExtensionActivationPolicy({
      project: () => ({ allowed: true, revision: 1 }),
      thread: () => ({ allowed: options.threadAllowed ?? true, revision: 1 }),
    }),
    compatibility: () => true,
    catalogStatus: () => "available",
  });
  const connections = vi.fn(async () => ({
    servers: [
      ["linear", linear],
      ["docs", docs],
    ].map(([slug, extensionId]) => ({
      extensionId,
      packageId: extensionId,
      componentId: "mcp",
      packageName: slug,
      serverName: slug,
      transport: "streamable-http",
      state: options.states?.[String(slug)] ?? "needs-sign-in",
    })),
  }));
  const reader = createThreadMcpSignInReader({
    snapshot: () => snapshot,
    resolveEffectiveState: (state, query) => activation.resolve(state, query),
    thread: () =>
      options.thread === null
        ? undefined
        : {
            projectId: projectId as never,
            version: 1,
            providerInstanceId: "95000000-0000-4000-8000-000000000003" as never,
            modelId: "model-a" as never,
            providerFamily,
            pinnedExtensionIds: options.pins ?? [],
            ...options.thread,
          },
    connections: connections as never,
  });
  const selection = (extensionId: string, slug: string, epoch?: string) =>
    Schema.decodeUnknownSync(ExtensionSelection)({
      kind: "plugin",
      extensionId,
      packageId: extensionId,
      componentId: "mcp",
      packageVersion: "1.0.0",
      packageDigest: digest,
      catalogEpoch:
        epoch ??
        activation.resolve(snapshot, {
          scope: {
            hostId: LOCAL_HOST_ID,
            mode,
            projectId: projectId as never,
            threadId,
            providerFamily,
          },
        }).catalogEpoch,
      origin: { kind: "draft", reference: slug },
    });
  const read = async (selections: ReadonlyArray<ExtensionSelection> = []) =>
    (await reader({ kind: "thread-sign-in", mode, threadId, selections })).servers.map(
      (server) => server.serverName,
    );
  return { read, selection, connections };
}

describe("servers a thread's next turn needs signed in", () => {
  it.each(["chat", "work", "code"] as const)(
    "names the server a %s draft selects and no other that needs sign-in",
    async (mode) => {
      const test = fixture({ mode });
      await expect(test.read([test.selection(linear, "linear")])).resolves.toEqual(["linear"]);
    },
  );

  it("names the server pinned to the thread's Project", async () => {
    const test = fixture({ pins: [docs] });
    await expect(test.read()).resolves.toEqual(["docs"]);
  });

  it("says nothing, and reads no connection, in a thread that uses no server", async () => {
    const test = fixture();
    await expect(test.read()).resolves.toEqual([]);
    expect(test.connections).not.toHaveBeenCalled();
  });

  it("says nothing once the server is signed in", async () => {
    const test = fixture({ pins: [linear], states: { linear: "ready" } });
    await expect(test.read()).resolves.toEqual([]);
  });

  it.each([
    ["the plugin is switched off", { linear: { ...on, pluginDesired: false } }],
    ["the plugin is not trusted", { linear: { ...on, trusted: false } }],
    ["the thread may use no extension", { threadAllowed: false }],
    ["the thread's turns carry no extension tools", { thread: null }],
  ])("says nothing when %s", async (_why, options) => {
    const test = fixture({ ...options, pins: [linear] });
    await expect(test.read([test.selection(linear, "linear")])).resolves.toEqual([]);
  });

  it("ignores a selection the turn itself would refuse as stale", async () => {
    const test = fixture();
    const stale = test.selection(linear, "linear", `sha256:${"0".repeat(64)}`);
    await expect(test.read([stale])).resolves.toEqual([]);
  });

  it("names a server once when the draft selects it and the Project pins it", async () => {
    const test = fixture({ pins: [linear] });
    await expect(test.read([test.selection(linear, "linear")])).resolves.toEqual(["linear"]);
  });
});

describe("what a thread's next turn runs as", () => {
  const records = (
    options: {
      readonly onServer?: boolean;
      readonly strict?: boolean;
      readonly platform?: string;
      readonly carriesTools?: boolean;
      readonly driverKind?: string | undefined;
    } = {},
  ) => {
    const base = {
      id: threadId,
      projectId,
      version: 3,
      providerInstanceId: "95000000-0000-4000-8000-000000000003",
      modelId: "model-a",
    };
    return createThreadMcpSignInThreads({
      readChatThread: () => base as never,
      readWorkThread: () => ({ ...base, access: "ask" }) as never,
      readCodeThread: () => ({ ...base, executionPolicy: "approval-gated" }) as never,
      driverKind: () => ("driverKind" in options ? options.driverKind : "openai-compatible"),
      onServer: () => options.onServer ?? false,
      strict: () => options.strict ?? false,
      carriesAppManagedTools: () => options.carriesTools,
      pinnedExtensionIds: () => [linear],
      platform: options.platform ?? "darwin",
    });
  };

  it("takes the Project's pins for Work and Code, and none for Chat", () => {
    const read = records();
    expect(read("work", threadId)?.pinnedExtensionIds).toEqual([linear]);
    expect(read("code", threadId)?.pinnedExtensionIds).toEqual([linear]);
    expect(read("chat", threadId)).toMatchObject({ projectId, pinnedExtensionIds: [] });
  });

  it.each([
    ["the Project is on a server", { onServer: true }],
    ["the model is known not to carry Octant's tools", { carriesTools: false }],
    ["it runs under Strict on Windows", { strict: true, platform: "win32" }],
    ["the provider is gone", { driverKind: undefined }],
  ])("has no extension tools when %s", (_why, options) => {
    expect(records(options)("work", threadId)).toBeUndefined();
    expect(records(options)("code", threadId)).toBeUndefined();
  });
});
