import {
  decodeChatBootstrap,
  decodeChatThread,
  decodeChatThreadView,
  decodeCodeBootstrap,
  decodeCodeBoardView,
  decodeWorkThread,
  decodeWorkThreadBootstrap,
  decodeProjectBootstrap,
  decodeProviderInstance,
  decodeProviderModelId,
  decodeProviderRegistrySnapshot,
  type ChatThread,
  type ChatThreadView,
  type CodeThread,
  type WorkThread,
  type ProviderInstanceId,
} from "@octant/contracts";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import type { MobileHostRegistration } from "../hosts/HostRegistry";
import type { MobileHostHealth } from "../session/MobileHostSessionHub";

export type MobileMockScenarioId = "full" | "stale" | "empty";

export interface MobileMockScenario {
  readonly id: MobileMockScenarioId;
  readonly label: string;
  readonly hosts: ReadonlyArray<MobileHostRegistration>;
  readonly health: ReadonlyArray<MobileHostHealth>;
  readonly transports: ReadonlyArray<MobileRemoteTransport>;
}

const NOW = "2026-08-10T09:30:00.000Z";
const EARLIER = "2026-08-10T08:45:00.000Z";
const PROVIDER_ID = "10000000-0000-4000-8000-000000000001" as ProviderInstanceId;
const MODEL_ID = "gpt-5.6";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const CODE_PROJECT_ID = "20000000-0000-4000-8000-000000000002";
const BINDING_ID = "30000000-0000-4000-8000-000000000001";
const STUDIO_HOST_ID = "11111111-1111-4111-8111-111111111111";
const MACBOOK_HOST_ID = "22222222-2222-4222-8222-222222222222";
const DEVBOX_HOST_ID = "33333333-3333-4333-8333-333333333333";
const CHAT_THREAD_ID = "40000000-0000-4000-8000-000000000001";
const CHAT_WAITING_ID = "40000000-0000-4000-8000-000000000002";
const WORK_THREAD_ID = "50000000-0000-4000-8000-000000000001";
const CODE_THREAD_ID = "60000000-0000-4000-8000-000000000001";
const CHECKOUT_ID = "70000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = `repo_${"a".repeat(64)}`;

const chatSettings = {
  defaultProviderInstanceId: PROVIDER_ID,
  defaultModelId: MODEL_ID,
  defaultResearchEnabled: false,
  defaultResearchRouting: "automatic",
  defaultPersonalityInstructions: "Be direct and practical.",
  version: 1,
  updatedAt: NOW,
} as const;

const codeSettings = {
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "current-session",
  version: 1,
  updatedAt: NOW,
} as const;

const capabilities = {
  streaming: "supported",
  resume: "supported",
  interruption: "supported",
  approvals: "supported",
  userQuestions: "supported",
  reasoning: "supported",
  usage: "supported",
  toolActivity: "supported",
  fileChanges: "supported",
  diffs: "supported",
  taskProgress: "supported",
  nativeChildAgents: "unavailable",
  nativeAttachments: "supported",
  nativeWebResearch: "unsupported",
  appManagedTools: "supported",
  citations: "supported",
} as const;

function createChatThread(input: {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}): ChatThread {
  return decodeChatThread({
    id: input.id,
    title: input.title,
    lifecycle: "active",
    providerInstanceId: PROVIDER_ID,
    modelId: MODEL_ID,
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be direct and practical.",
    version: 3,
    createdAt: EARLIER,
    updatedAt: input.updatedAt,
  });
}

function createChatView(thread: ChatThread, rich: boolean): ChatThreadView {
  if (!rich) {
    return decodeChatThreadView({
      thread,
      turns: [],
      lastSequence: 0,
      contents: [],
      attachments: [],
      citations: [],
      workItems: [],
      workListVersion: 1,
      followUpVersion: 1,
    });
  }

  return decodeChatThreadView({
    thread,
    turns: [],
    lastSequence: 8,
    contents: [
      {
        contentId: "81000000-0000-4000-8000-000000000001",
        role: "user",
        body: "Review the mobile workspace and prepare the next safe delivery slice.",
        digest: "1".repeat(64),
        byteLength: 66,
      },
      {
        contentId: "81000000-0000-4000-8000-000000000002",
        role: "assistant",
        body: "The native baseline is healthy enough to iterate. I mapped the remaining gates and prepared the mock review surface.",
        digest: "2".repeat(64),
        byteLength: 112,
        parts: [
          {
            kind: "reasoning",
            text: "Checking authority, native configuration, and the review evidence before proposing changes.",
          },
          {
            kind: "tool",
            name: "mobile_quality_check",
            status: "done",
            summary: "Expo configuration and focused tests inspected",
          },
          {
            kind: "markdown",
            text: "## Ready for review\n\n- Mock workspace is isolated\n- Native gates remain explicit\n- Production sessions stay host-authoritative",
          },
        ],
      },
    ],
    attachments: [
      {
        id: "82000000-0000-4000-8000-000000000001",
        threadId: thread.id,
        displayName: "mobile-review.png",
        mediaType: "image/png",
        byteLength: 128_000,
        digest: "3".repeat(64),
        status: "finalized",
        createdAt: NOW,
      },
    ],
    citations: [],
    workItems: [
      {
        id: "83000000-0000-4000-8000-000000000001",
        threadId: thread.id,
        title: "Polish the populated inbox",
        detail: "Check hierarchy, status density, and small-screen ergonomics.",
        status: "in-progress",
        position: 0,
        origin: "agent",
        version: 2,
        createdAt: EARLIER,
        updatedAt: NOW,
      },
      {
        id: "83000000-0000-4000-8000-000000000002",
        threadId: thread.id,
        title: "Validate the locked and stale states",
        status: "pending",
        position: 1,
        origin: "user",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    workListVersion: 3,
    followUpVersion: 2,
    followUp: {
      threadId: thread.id,
      state: "open",
      origin: "manual",
      reason: "Confirm the mobile hierarchy before device QA.",
      triggerSequence: 8,
      acknowledgedThroughSequence: 0,
      createdAt: NOW,
    },
  });
}

function createWorkThread(
  input: {
    readonly id?: string | undefined;
    readonly projectId?: string | undefined;
    readonly title?: string | undefined;
    readonly providerInstanceId?: string | undefined;
    readonly modelId?: string | undefined;
  } = {},
): WorkThread {
  return decodeWorkThread({
    id: input.id ?? WORK_THREAD_ID,
    projectId: input.projectId ?? PROJECT_ID,
    title: input.title ?? "Travel launch checklist",
    lifecycle: "active",
    providerInstanceId: input.providerInstanceId ?? PROVIDER_ID,
    modelId: input.modelId ?? MODEL_ID,
    bindingRevisionId: BINDING_ID,
    version: 2,
    createdAt: EARLIER,
    updatedAt: NOW,
  });
}

function createCodeThread(lifecycle: "active" | "waiting" = "active"): CodeThread {
  return {
    id: CODE_THREAD_ID,
    projectId: CODE_PROJECT_ID,
    bindingRevisionId: BINDING_ID,
    repositoryId: REPOSITORY_ID,
    checkoutId: CHECKOUT_ID,
    title: "Mobile mock-data foundation",
    lifecycle,
    providerInstanceId: PROVIDER_ID,
    modelId: MODEL_ID,
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/issue-812-mobile-polish-mock",
      remoteName: "origin",
      proposedBaseRepository: "octocat/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: NOW,
    },
    version: 4,
    createdAt: EARLIER,
    updatedAt: NOW,
  } as CodeThread;
}

function mockUuid(prefix: number, sequence: number): string {
  return `${prefix.toString(16).padStart(2, "0")}${sequence.toString(16).padStart(6, "0")}-0000-4000-8000-000000000001`;
}

function mockDigest(sequence: number): string {
  return (sequence % 256).toString(16).padStart(2, "0").repeat(32);
}

function appendMockChatTurn(
  view: ChatThreadView,
  prompt: string,
  mutationSequence: number,
): ChatThreadView {
  const turnSequence = view.lastSequence + 1;
  const turnId = mockUuid(0x86, mutationSequence);
  const userMessage = {
    contentId: mockUuid(0x85, mutationSequence),
    role: "user" as const,
    body: prompt,
    digest: mockDigest(mutationSequence),
    byteLength: new TextEncoder().encode(prompt).byteLength,
  };
  const turn = {
    id: turnId,
    threadId: view.thread.id,
    sequence: turnSequence,
    userMessageRef: {
      contentId: userMessage.contentId,
      digest: userMessage.digest,
      byteLength: userMessage.byteLength,
    },
    attachmentIds: [],
    attempts: [
      {
        id: mockUuid(0x87, mutationSequence),
        turnId,
        threadId: view.thread.id,
        providerInstanceId: view.thread.providerInstanceId,
        providerSessionId: mockUuid(0x88, mutationSequence),
        modelId: view.thread.modelId,
        contextManifestId: mockUuid(0x89, mutationSequence),
        outcome: "completed" as const,
        responseRefs: [],
        citationIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    createdAt: NOW,
  };
  return decodeChatThreadView({
    ...view,
    thread: { ...view.thread, version: view.thread.version + 1, updatedAt: NOW },
    turns: [...view.turns, turn],
    lastSequence: turnSequence,
    contents: [...view.contents, userMessage],
  });
}

function createCodeBoardView(threads: ReadonlyArray<CodeThread>) {
  return decodeCodeBoardView({
    version: 1,
    query: { version: 1, statuses: ["ready", "in-progress", "waiting", "done"] },
    cards: threads.map((thread) => ({
      threadId: thread.id,
      projectId: thread.projectId,
      checkoutId: thread.checkoutId,
      checkoutKind: "existing-worktree",
      title: thread.title,
      status: thread.lifecycle === "waiting" ? "waiting" : "in-progress",
      statusReason: thread.lifecycle === "waiting" ? "awaiting-input" : "executing",
      outcomeKind: thread.deliveryTarget.outcomeKind,
      deliverySatisfaction: "pending",
      providerInstanceId: thread.providerInstanceId,
      modelId: thread.modelId,
      executing: thread.lifecycle === "active",
      worktree: {
        kind: "available",
        checkoutId: thread.checkoutId,
        path: "/mock/octant",
        head: {
          kind: "branch",
          name: "feature/issue-812-mobile-polish-mock",
          oid: "a".repeat(40),
        },
      },
      changedFiles: {
        kind: "observed",
        freshness: "fresh",
        changedPathCount: 1,
        stagedCount: 1,
        committedAhead: 0,
        workingTreeClean: false,
      },
      linkedPullRequest: { kind: "none", freshness: "fresh" },
      checks: { freshness: "fresh", state: "passing" },
      reviewState: { freshness: "fresh", state: "approved" },
      childAgents: { active: 0, completed: 0, failed: 0, unacknowledgedResults: 0 },
      recovery: { kind: "ok" },
      githubFreshness: "fresh",
      followUp: false,
      lastMeaningfulActivityAt: thread.updatedAt,
    })),
    generatedAt: NOW,
  });
}

function providerSnapshot() {
  return decodeProviderRegistrySnapshot({
    instances: [
      decodeProviderInstance({
        id: PROVIDER_ID,
        displayName: "OpenAI",
        driverKind: "openai-compatible",
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: "https://provider.octant.invalid/v1/",
          authentication: "none",
          protocol: "responses",
          manualModelIds: [],
        },
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: EARLIER,
        updatedAt: NOW,
      }),
    ],
    defaults: { permissionPersistence: "current-session", version: 1 },
    observedStates: [
      {
        instanceId: PROVIDER_ID,
        readiness: "ready",
        processState: "running",
        models: [
          {
            id: decodeProviderModelId(MODEL_ID),
            displayName: "GPT-5.6",
            source: "discovered",
            verification: "verified",
            reasoning: "supported",
            inputModalities: ["text", "image"],
            options: [],
          },
        ],
        capabilities,
        observedAt: NOW,
      },
    ],
  });
}

function projectBootstrap() {
  return decodeProjectBootstrap({
    active: [
      {
        id: PROJECT_ID,
        name: "Octant Mobile",
        type: "work",
        lifecycle: "active",
        pinned: true,
        rank: "0/1",
        binding: { canonicalRoot: "/mock/octant-mobile" },
        bindingRevisionId: BINDING_ID,
        version: 2,
        createdAt: EARLIER,
        updatedAt: NOW,
      },
      {
        id: CODE_PROJECT_ID,
        name: "Octant",
        type: "code",
        lifecycle: "active",
        pinned: true,
        rank: "1/1",
        binding: { canonicalRoot: "/mock/octant" },
        bindingRevisionId: BINDING_ID,
        codeAccessPersistence: "current-session",
        version: 2,
        createdAt: EARLIER,
        updatedAt: NOW,
      },
    ],
    archived: [],
    availability: [
      { projectId: PROJECT_ID, status: "available", observedAt: NOW },
      { projectId: CODE_PROJECT_ID, status: "available", observedAt: NOW },
    ],
    memory: [],
  });
}

function pullRequestReview(operationId: string) {
  return {
    kind: "pull-request-review",
    operationId,
    state: "observed",
    freshness: "fresh",
    ambiguous: false,
    staleSections: [],
    number: 812,
    url: "https://github.com/octocat/octant/pull/812",
    title: "Polish the native mobile review loop",
    pullRequestState: "open",
    baseRepository: "octocat/octant",
    baseBranch: "development",
    headRepository: "octocat/octant",
    headBranch: "feature/issue-812-mobile-polish-mock",
    author: "octocat",
    matchesDeliveryBranch: true,
    description: {
      contentId: "84000000-0000-4000-8000-000000000001",
      digest: "4".repeat(64),
      byteLength: 180,
    },
    diff: {
      contentId: "84000000-0000-4000-8000-000000000002",
      digest: "5".repeat(64),
      byteLength: 2_400,
    },
    commits: [
      {
        oid: "a".repeat(40),
        messageHeadline: "feat(mobile): add safe mock review mode",
        author: "octocat",
      },
    ],
    files: [
      { path: "apps/mobile/src/App.tsx", additions: 42, deletions: 12 },
      { path: "apps/mobile/src/dev/mobileMockScenario.ts", additions: 280, deletions: 0 },
      { path: "apps/mobile/app.config.ts", additions: 14, deletions: 2 },
    ],
    checks: [
      { name: "mobile tests", state: "success" },
      { name: "typecheck", state: "success" },
      { name: "device smoke", state: "pending" },
    ],
    reviews: [{ author: "reviewer", state: "approved", body: "Ready for device QA." }],
    comments: [{ author: "octocat", body: "Mock review pass complete." }],
  } as const;
}

function waitForAbort(signal: AbortSignal | undefined): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal?.aborted) {
        controller.close();
        return;
      }
      signal?.addEventListener("abort", () => controller.close(), { once: true });
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson" },
  });
}

function createMockTransport(input: {
  readonly hostId: string;
  readonly chatThreads: ReadonlyArray<ChatThread>;
  readonly chatViews: ReadonlyArray<ChatThreadView>;
  readonly workThreads: ReadonlyArray<WorkThread>;
  readonly codeThreads: ReadonlyArray<CodeThread>;
}): MobileRemoteTransport {
  const chatThreads = [...input.chatThreads];
  const chatViews = new Map(input.chatViews.map((view) => [String(view.thread.id), view]));
  const workThreads = [...input.workThreads];
  const codeThreads = [...input.codeThreads];
  let mockChatMutationSequence = 0;
  const codeCheckout = {
    id: CHECKOUT_ID,
    repositoryId: REPOSITORY_ID,
    kind: "existing-worktree",
    availability: "available",
    head: { kind: "branch", name: "feature/issue-812-mobile-polish-mock", oid: "a".repeat(40) },
    observedAt: NOW,
  } as const;

  return {
    hostId: input.hostId,
    async authenticatedFetch(request) {
      if (request.method === "GET" && request.path === "/api/chat/bootstrap") {
        return Response.json(decodeChatBootstrap({ settings: chatSettings, threads: chatThreads }));
      }
      if (request.method === "GET" && request.path === "/api/work/threads/bootstrap") {
        return Response.json(decodeWorkThreadBootstrap({ threads: workThreads }));
      }
      if (request.method === "GET" && request.path === "/api/code/bootstrap") {
        return Response.json(
          decodeCodeBootstrap({
            settings: codeSettings,
            threads: codeThreads,
            checkouts: [codeCheckout],
            activity: [],
          }),
        );
      }
      if (request.method === "POST" && request.path === "/api/code/board") {
        return Response.json(createCodeBoardView(codeThreads));
      }
      if (request.method === "GET" && request.path === "/api/providers/bootstrap") {
        return Response.json(providerSnapshot());
      }
      if (request.method === "GET" && request.path === "/api/projects/bootstrap") {
        return Response.json(projectBootstrap());
      }
      if (request.method === "GET" && request.path.endsWith("/events")) {
        return waitForAbort(request.signal);
      }
      if (request.method === "GET" && request.path.startsWith("/api/chat/threads/")) {
        const threadId = decodeURIComponent(request.path.slice("/api/chat/threads/".length));
        const view = chatViews.get(threadId);
        return view === undefined ? new Response("missing", { status: 404 }) : Response.json(view);
      }
      if (request.method === "GET" && request.path.startsWith("/api/code/threads/")) {
        const threadId = decodeURIComponent(request.path.slice("/api/code/threads/".length));
        const thread = codeThreads.find((candidate) => String(candidate.id) === threadId);
        return thread === undefined
          ? new Response("missing", { status: 404 })
          : Response.json({ thread, checkout: codeCheckout, lastSequence: 0 });
      }
      if (request.method === "POST" && request.path === "/api/code/commands") {
        const command = JSON.parse(String(request.body ?? "{}")) as {
          readonly kind?: string;
          readonly operationId?: string;
          readonly threadId?: string;
          readonly title?: string;
          readonly providerInstanceId?: string;
          readonly modelId?: string;
          readonly deliveryTarget?: CodeThread["deliveryTarget"];
          readonly thread?: {
            readonly id?: string;
            readonly title?: string;
            readonly providerInstanceId?: string;
            readonly modelId?: string;
            readonly deliveryTarget?: CodeThread["deliveryTarget"];
          };
        };
        if (command.kind === "prepare-code-project-checkout") {
          return Response.json({
            kind: "checkout-prepared",
            bindingRevisionId: BINDING_ID,
            checkout: codeCheckout,
          });
        }
        if (command.kind === "get-worktree-remote-facts") {
          return Response.json({
            kind: "worktree-remote-facts-retrieved",
            projectId: CODE_PROJECT_ID,
            facts: { remotes: ["origin"], defaultRemote: "origin" },
          });
        }
        const createdThreadFields =
          command.kind === "create-code-thread"
            ? command.thread === undefined
              ? undefined
              : {
                  id: command.thread.id,
                  title: command.thread.title,
                  providerInstanceId: command.thread.providerInstanceId,
                  modelId: command.thread.modelId,
                  deliveryTarget: command.thread.deliveryTarget,
                }
            : command.kind === "create-managed-code-thread"
              ? {
                  id: command.threadId,
                  title: command.title,
                  providerInstanceId: command.providerInstanceId,
                  modelId: command.modelId,
                  deliveryTarget: command.deliveryTarget,
                }
              : undefined;
        if (
          createdThreadFields !== undefined &&
          createdThreadFields.id !== undefined &&
          createdThreadFields.title !== undefined &&
          createdThreadFields.providerInstanceId !== undefined &&
          createdThreadFields.modelId !== undefined &&
          createdThreadFields.deliveryTarget !== undefined
        ) {
          const thread = {
            ...createCodeThread("active"),
            id: createdThreadFields.id,
            title: createdThreadFields.title,
            providerInstanceId: createdThreadFields.providerInstanceId,
            modelId: createdThreadFields.modelId,
            deliveryTarget: createdThreadFields.deliveryTarget,
            version: 1,
            createdAt: NOW,
            updatedAt: NOW,
          } as CodeThread;
          codeThreads.unshift(thread);
          return Response.json(
            command.kind === "create-code-thread"
              ? { kind: "thread-created", thread }
              : {
                  kind: "managed-thread-created",
                  thread,
                  checkout: codeCheckout,
                  provenance: {
                    receiptId: "90000000-0000-4000-8000-000000000001",
                    mode: "local",
                    branch: "feature/issue-812-mobile-polish-mock",
                    resolvedHead: "a".repeat(40),
                  },
                },
          );
        }
        if (command.kind === "start-provider-turn" && command.operationId !== undefined) {
          return Response.json({
            kind: "provider-turn-state",
            operationId: command.operationId,
            state: "running",
          });
        }
        if (command.kind === "observe-pull-request" && command.operationId !== undefined) {
          return Response.json(pullRequestReview(command.operationId));
        }
        return Response.json({
          kind: "pull-request-state",
          operationId: command.operationId,
          state: "failed",
          failureCode: "checks",
        });
      }
      if (request.method === "PUT" && request.path === "/api/code/evidence") {
        const body = String(request.body ?? "");
        return Response.json({
          contentId: "80000000-0000-4000-8000-000000000001",
          digest: "f".repeat(64),
          byteLength: new TextEncoder().encode(body).byteLength,
        });
      }
      if (request.method === "POST" && request.path === "/api/chat/commands") {
        const command = JSON.parse(String(request.body ?? "{}")) as {
          readonly kind?: string;
          readonly title?: string;
          readonly threadId?: string;
          readonly prompt?: string;
        };
        if (command.kind === "create-chat-thread") {
          const thread = createChatThread({
            id: command.threadId ?? mockUuid(0x84, ++mockChatMutationSequence),
            title: command.title ?? "Mock chat",
            updatedAt: NOW,
          });
          chatThreads.unshift(thread);
          chatViews.set(String(thread.id), createChatView(thread, false));
          return Response.json({ kind: "thread-created", thread });
        }
        if (command.kind === "change-chat-provider" && command.threadId !== undefined) {
          const thread = chatThreads.find((entry) => String(entry.id) === command.threadId);
          if (thread === undefined) return new Response("missing", { status: 404 });
          const updated = decodeChatThread({
            ...thread,
            version: thread.version + 1,
            updatedAt: NOW,
          });
          const view = chatViews.get(command.threadId);
          if (view !== undefined) {
            chatViews.set(command.threadId, { ...view, thread: updated });
          }
          return Response.json({ kind: "thread-updated", thread: updated });
        }
        if (
          command.kind === "send-chat-turn" &&
          command.threadId !== undefined &&
          command.prompt !== undefined
        ) {
          const view = chatViews.get(command.threadId);
          if (view === undefined) return new Response("missing", { status: 404 });
          const nextView = appendMockChatTurn(view, command.prompt, ++mockChatMutationSequence);
          chatViews.set(command.threadId, nextView);
          const threadIndex = chatThreads.findIndex(
            (entry) => String(entry.id) === command.threadId,
          );
          if (threadIndex >= 0) chatThreads[threadIndex] = nextView.thread;
          return Response.json({ kind: "turn-created", turn: nextView.turns.at(-1) });
        }
        return Response.json({ kind: "command-accepted" });
      }
      if (request.method === "POST" && request.path === "/api/work/threads/commands") {
        const command = JSON.parse(String(request.body ?? "{}")) as {
          readonly kind?: string;
          readonly threadId?: string;
          readonly projectId?: string;
          readonly title?: string;
          readonly providerInstanceId?: string;
          readonly modelId?: string;
        };
        if (command.kind !== "create-work-thread") {
          return new Response("Mock route not found", { status: 404 });
        }
        const thread = createWorkThread({
          id: command.threadId,
          projectId: command.projectId,
          title: command.title,
          providerInstanceId: command.providerInstanceId,
          modelId: command.modelId,
        });
        workThreads.unshift(thread);
        return Response.json({ kind: "thread-created", thread });
      }
      return new Response("Mock route not found", { status: 404 });
    },
  };
}

function registration(input: {
  readonly hostId: string;
  readonly origin: string;
  readonly label: string;
}): MobileHostRegistration {
  return {
    ...input,
    keyId: `mock-key-${input.hostId}`,
    credentialGeneration: 1,
    hostKeyFingerprint: "mock-fingerprint",
  };
}

export function resolveMobileMockScenario(
  configured: unknown,
  isDevelopment: boolean,
): MobileMockScenarioId | undefined {
  if (!isDevelopment) return undefined;
  return configured === "full" || configured === "stale" || configured === "empty"
    ? configured
    : undefined;
}

export function createMobileMockScenario(id: MobileMockScenarioId): MobileMockScenario {
  if (id === "empty") {
    return { id, label: "Empty workspace", hosts: [], health: [], transports: [] };
  }

  const studio = registration({
    hostId: STUDIO_HOST_ID,
    origin: "https://studio.octant.invalid",
    label: "Studio Mac",
  });
  const macbook = registration({
    hostId: MACBOOK_HOST_ID,
    origin: "https://travel.octant.invalid",
    label: "Travel MacBook",
  });
  const devbox = registration({
    hostId: DEVBOX_HOST_ID,
    origin: "https://devbox.octant.invalid",
    label: "Devbox",
  });
  const mainChat = createChatThread({
    id: CHAT_THREAD_ID,
    title: "Polish the mobile review loop",
    updatedAt: NOW,
  });
  const waitingChat = createChatThread({
    id: CHAT_WAITING_ID,
    title: "Plan the TestFlight device pass",
    updatedAt: EARLIER,
  });
  const work = createWorkThread();
  const code = createCodeThread(id === "stale" ? "waiting" : "active");
  const studioTransport = createMockTransport({
    hostId: STUDIO_HOST_ID,
    chatThreads: [mainChat, waitingChat],
    chatViews: [createChatView(mainChat, true), createChatView(waitingChat, false)],
    workThreads: [work],
    codeThreads: [code],
  });
  const travelTransport = createMockTransport({
    hostId: MACBOOK_HOST_ID,
    chatThreads: [],
    chatViews: [],
    workThreads: [],
    codeThreads: [],
  });

  if (id === "stale") {
    return {
      id,
      label: "Stale host",
      hosts: [studio],
      health: [
        {
          hostId: STUDIO_HOST_ID,
          origin: studio.origin,
          label: studio.label,
          kind: "stale",
          detail: "Last host refresh was 12 minutes ago",
        },
      ],
      transports: [studioTransport],
    };
  }

  return {
    id,
    label: "Full workspace",
    hosts: [studio, macbook, devbox],
    health: [
      {
        hostId: STUDIO_HOST_ID,
        origin: studio.origin,
        label: studio.label,
        kind: "ready",
      },
      {
        hostId: MACBOOK_HOST_ID,
        origin: macbook.origin,
        label: macbook.label,
        kind: "stale",
        detail: "Read-only until the host reconnects",
      },
      {
        hostId: DEVBOX_HOST_ID,
        origin: devbox.origin,
        label: devbox.label,
        kind: "unavailable",
        detail: "Private listener is offline",
      },
    ],
    transports: [studioTransport, travelTransport],
  };
}
