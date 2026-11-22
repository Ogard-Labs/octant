import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AutomationClient } from "@octant/client-runtime";
import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import type { UsageDashboardClient } from "@octant/client-runtime";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import {
  decodeAgentRunCenterSummary,
  decodeCodeThreadId,
  decodeLocalUsageHistoryResponse,
  decodeProjectId,
  decodeProviderInstance,
  decodeProviderUsageLimitsSnapshot,
  decodeWorkspaceTab,
  decodeWorkspaceTabId,
  type AgentRunCenterSummary,
  type CodeEnvironmentObservation,
  type LocalUsageHistoryResponse,
  type ProjectSummary,
  type UsageDashboardResponse,
  type WorkspaceTab,
} from "@octant/contracts";
import type { ArtifactLibraryListing } from "@octant/contracts/artifact-library";
import {
  AUTOMATION_UI_TEST_IDS,
  automationSummaryFixture,
} from "../automation/automationTestFixtures";
import type { AgentHierarchyInputEntry } from "../agents/buildAgentHierarchyModel";
import { buildChildRunStatusSummary } from "../agents/buildChildRunStatusSummary";
import type { ChildRunStatusController } from "../agents/useChildRunStatus";
import type { AutomationEditorCatalog } from "../automation/automationCenterModel";
import { automationWorkDraftFixture } from "../automation/automationTestFixtures";

/**
 * Fixture data for the visual check's scenes. Every value is fixed, and the
 * clock the page runs on is fixed too (see `visualCheck.chromium.test.ts`), so
 * the same code draws the same picture. Shapes follow the fixtures the
 * component tests of each surface already use.
 */

/** The instant every scene treats as now. */
export const VISUAL_NOW = "2026-08-18T09:00:00.000Z";

const never = (): Promise<never> => new Promise<never>(() => undefined);

// --- Agents table ----------------------------------------------------------

function agentRun(
  index: number,
  fields: {
    readonly task: string;
    readonly parent: string;
    readonly lifecycleStatus: AgentRunCenterSummary["lifecycleStatus"];
    readonly model: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  },
): AgentRunCenterSummary {
  const hex = String(index).repeat(8);
  return decodeAgentRunCenterSummary({
    runId: `${hex}-1111-4111-8111-111111111111`,
    requestId: `${hex}-2222-4222-8222-222222222222`,
    parentThreadId: `${hex}-3333-4333-8333-333333333333`,
    parentThreadTitle: fields.parent,
    mode: "chat",
    role: "research",
    task: fields.task,
    lifecycleStatus: fields.lifecycleStatus,
    executionKind: "octant-managed",
    authority: {
      filesystem: false,
      shell: false,
      git: false,
      network: true,
      tools: true,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    },
    workspaceKind: "chat-virtual",
    usageQuality: "provider-reported",
    route: {
      requestedProviderInstanceId: "44444444-4444-4444-8444-444444444444",
      requestedModelId: fields.model,
      executionProviderInstanceId: "44444444-4444-4444-8444-444444444444",
      executionModelId: fields.model,
      poolDerived: false,
    },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 2,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
  });
}

const AGENT_RUNS: ReadonlyArray<AgentRunCenterSummary> = [
  agentRun(1, {
    task: "Summarize the design",
    parent: "Design chat",
    lifecycleStatus: "running",
    model: "gpt-4o",
    createdAt: "2026-08-18T08:40:00.000Z",
    updatedAt: "2026-08-18T08:58:00.000Z",
  }),
  agentRun(2, {
    task: "Compare the two pricing pages",
    parent: "Pricing review",
    lifecycleStatus: "completed",
    model: "gpt-4o",
    createdAt: "2026-08-18T07:10:00.000Z",
    updatedAt: "2026-08-18T07:31:00.000Z",
  }),
  agentRun(3, {
    task: "List the open accessibility issues",
    parent: "Release checklist",
    lifecycleStatus: "completed",
    model: "gpt-4o-mini",
    createdAt: "2026-08-17T15:00:00.000Z",
    updatedAt: "2026-08-17T15:12:00.000Z",
  }),
  agentRun(4, {
    task: "Check the migration plan against the schema",
    parent: "Schema work",
    lifecycleStatus: "failed",
    model: "gpt-4o",
    createdAt: "2026-08-17T09:00:00.000Z",
    updatedAt: "2026-08-17T09:05:00.000Z",
  }),
  agentRun(5, {
    task: "Draft release notes from the merged work",
    parent: "Release notes",
    lifecycleStatus: "cancelled",
    model: "gpt-4o-mini",
    createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:02:00.000Z",
  }),
];

export function agentRunClient(): AgentRunClient {
  return {
    center: async () => ({ items: AGENT_RUNS }),
    conversation: never,
    parentSummary: never,
    snapshotCanvas: never,
    acknowledge: never,
    cancel: never,
    steer: never,
    retry: never,
    resume: never,
    usageResume: never,
  } as AgentRunClient;
}

// --- Automations table -----------------------------------------------------

const AUTOMATION_IDS = [
  "aa000000-0000-4000-8000-000000000001",
  "aa000000-0000-4000-8000-000000000002",
  "aa000000-0000-4000-8000-000000000003",
  "aa000000-0000-4000-8000-000000000004",
  "aa000000-0000-4000-8000-000000000005",
] as const;

export function automationClient(): AutomationClient {
  const items = [
    automationSummaryFixture({ id: AUTOMATION_IDS[0], displayName: "Weekly summary" } as never),
    automationSummaryFixture({
      id: AUTOMATION_IDS[1],
      displayName: "Nightly build check",
      mode: "code",
      projectId: AUTOMATION_UI_TEST_IDS.otherProject,
      lifecycle: "paused",
      nextDueAt: null,
      latestRunLifecycle: "failed",
    } as never),
    automationSummaryFixture({
      id: AUTOMATION_IDS[2],
      displayName: "Friday digest",
      trigger: { kind: "weekly-local", weekdays: [5], localTime: "16:30", timeZone: "UTC" },
      nextDueAt: "2026-08-21T16:30:00.000Z",
    } as never),
    automationSummaryFixture({
      id: AUTOMATION_IDS[3],
      displayName: "Dependency audit",
      mode: "code",
      projectId: AUTOMATION_UI_TEST_IDS.otherProject,
      trigger: { kind: "weekly-local", weekdays: [2], localTime: "07:00", timeZone: "UTC" },
      nextDueAt: "2026-08-25T07:00:00.000Z",
      latestRunLifecycle: "completed",
    } as never),
    automationSummaryFixture({
      id: AUTOMATION_IDS[4],
      displayName: "Check for the reply",
      trigger: { kind: "once", scheduledAt: "2026-08-19T09:00:00.000Z" },
      nextDueAt: "2026-08-19T09:00:00.000Z",
    } as never),
  ];
  return {
    list: async () => ({ kind: "automation-list" as const, items }),
    get: never,
    history: never,
    execute: never,
  } as unknown as AutomationClient;
}

export function automationCatalog(): AutomationEditorCatalog {
  const draft = automationWorkDraftFixture();
  return {
    hosts: [{ hostId: "local", label: "This Mac" }],
    projects: [
      {
        projectId: draft.projectId,
        name: "Docs Project",
        mode: "work",
        projectVersion: draft.projectVersion,
        binding: draft.binding,
      },
    ],
    executionProfiles: [{ label: "Work default", receipt: draft.executionProfile }],
    authorityProfiles: [{ label: "Ask for approvals Work", receipt: draft.authorityProfile }],
    actorId: AUTOMATION_UI_TEST_IDS.actor,
  };
}

// --- Artifacts table -------------------------------------------------------

export const ARTIFACT_LISTING = {
  kind: "artifact-library-listing",
  entries: [
    {
      canvasId: "10000000-0000-4000-8000-00000000000a",
      projectId: "20000000-0000-4000-8000-000000000001",
      projectName: "Storefront",
      mode: "work",
      kind: "chart",
      title: "Launch plan",
      versionCount: 3,
      currentVersionId: "30000000-0000-4000-8000-000000000001",
      currentSequence: 3,
      updatedAt: "2026-08-18T06:00:00.000Z",
      shared: true,
      tags: ["Launch"],
    },
    {
      canvasId: "10000000-0000-4000-8000-00000000000b",
      projectId: "20000000-0000-4000-8000-000000000002",
      projectName: "Octant",
      mode: "code",
      kind: "diagram",
      title: "Schema map",
      versionCount: 1,
      currentVersionId: "30000000-0000-4000-8000-000000000002",
      currentSequence: 1,
      updatedAt: "2026-08-15T09:00:00.000Z",
      shared: false,
    },
    {
      canvasId: "10000000-0000-4000-8000-00000000000c",
      projectId: "20000000-0000-4000-8000-000000000001",
      projectName: "Storefront",
      mode: "work",
      kind: "document",
      title: "Q3 report",
      versionCount: 5,
      currentVersionId: "30000000-0000-4000-8000-000000000003",
      currentSequence: 5,
      updatedAt: "2026-08-17T14:30:00.000Z",
      shared: true,
      tags: ["Finance", "Launch"],
    },
    {
      canvasId: "10000000-0000-4000-8000-00000000000d",
      projectId: "20000000-0000-4000-8000-000000000002",
      projectName: "Octant",
      mode: "code",
      kind: "chart",
      title: "Build times by week",
      versionCount: 2,
      currentVersionId: "30000000-0000-4000-8000-000000000004",
      currentSequence: 2,
      updatedAt: "2026-08-12T10:00:00.000Z",
      shared: false,
    },
    {
      canvasId: "10000000-0000-4000-8000-00000000000e",
      projectId: "20000000-0000-4000-8000-000000000001",
      projectName: "Storefront",
      mode: "work",
      kind: "diagram",
      title: "Checkout flow",
      versionCount: 1,
      currentVersionId: "30000000-0000-4000-8000-000000000005",
      currentSequence: 1,
      updatedAt: "2026-07-30T08:00:00.000Z",
      shared: false,
    },
  ],
  projects: [
    {
      projectId: "20000000-0000-4000-8000-000000000002",
      name: "Octant",
      mode: "code",
      artifactCount: 2,
    },
    {
      projectId: "20000000-0000-4000-8000-000000000001",
      name: "Storefront",
      mode: "work",
      artifactCount: 3,
    },
  ],
  tags: [
    { name: "Finance", artifactCount: 1 },
    { name: "Launch", artifactCount: 2 },
  ],
  matchCount: 5,
  truncated: false,
  generatedAt: VISUAL_NOW,
} as unknown as ArtifactLibraryListing;

// --- Code side panel -------------------------------------------------------

const CODE_PROJECT_ID = decodeProjectId("00000000-0000-4000-8000-000000000901");
const CODE_THREAD_ID = decodeCodeThreadId("00000000-0000-4000-8000-000000000701");

export const CODE_TAB: Extract<WorkspaceTab, { readonly mode: "code" }> = decodeWorkspaceTab({
  kind: "code-overview",
  id: decodeWorkspaceTabId("30000000-0000-4000-8000-00000000000a"),
  threadId: CODE_THREAD_ID,
  mode: "code",
  title: "Issue 204",
}) as Extract<WorkspaceTab, { readonly mode: "code" }>;

export const CODE_PROJECT = {
  id: CODE_PROJECT_ID,
  type: "code",
  name: "Octant",
  lifecycle: "active",
  pinned: true,
  rank: "0/1",
  version: 1,
  createdAt: "2026-07-16T08:00:00.000Z",
  updatedAt: "2026-07-16T08:00:00.000Z",
  binding: { canonicalRoot: "/Users/example/Dev/Repos/octant" },
  codeAccessPersistence: "current-session",
} as unknown as ProjectSummary;

const CODE_OBSERVATION = {
  status: "ready",
  projectId: CODE_PROJECT_ID,
  projectName: "Octant",
  repositoryRoot: "/Users/example/Dev/Repos/octant",
  worktreeRoot: "/Users/example/Dev/Repos/octant/.worktrees/issue-204",
  branch: { kind: "named", name: "feature/issue-204" },
  changes: "dirty",
  workingDirectory: ".",
  threadVersion: 1,
  observedAt: "2026-08-18T08:55:00.000Z",
} as unknown as CodeEnvironmentObservation;

export function codeProjectClient(): ProjectClient {
  return {
    bootstrap: never,
    search: never,
    executeProject: never,
    memory: never,
    environment: async () => CODE_OBSERVATION,
    environmentForThread: async () => CODE_OBSERVATION,
    executeMemory: never,
    listMemoryProposals: async () => [],
    decideMemoryProposal: never,
    listDesignSystems: never,
    readDesignSystem: never,
    saveDesignSystem: never,
  } as ProjectClient;
}

export function threadUsageClient(): UsageDashboardClient {
  const response = {
    summary: {
      totals: {
        totalInputTokens: 48200,
        totalOutputTokens: 9100,
        totalRequests: 14,
        exactCount: 13,
        estimatedCount: 1,
        reconciledCount: 0,
        staleCount: 0,
        unavailableCount: 0,
      },
      requestsWithUnavailableUsage: 0,
      coverage: [],
      excludedRecordCount: 0,
    },
    activity: [],
    activityTruncated: false,
    breakdown: [],
    detail: [],
    detailTruncated: false,
    hosts: [],
    dimensionSources: [],
    timeZone: "UTC",
    queryAt: VISUAL_NOW,
  } as unknown as UsageDashboardResponse;
  return { load: async () => response } as unknown as UsageDashboardClient;
}

/** Routines made from this thread, for the side panel's Routines group. */
export function threadRoutinesClient(): AutomationClient {
  const origin = "00000000-0000-4000-8000-000000000701";
  const items = [
    automationSummaryFixture({
      id: AUTOMATION_IDS[0],
      displayName: "Friday digest",
      originThreadId: origin,
    } as never),
    automationSummaryFixture({
      id: AUTOMATION_IDS[4],
      displayName: "Check for the reply",
      originThreadId: origin,
      targetPolicy: "same-thread",
      trigger: { kind: "once", scheduledAt: "2026-08-19T09:00:00.000Z" },
      nextDueAt: "2026-08-19T09:00:00.000Z",
    } as never),
  ];
  return {
    list: async () => ({ kind: "automation-list" as const, items }),
    get: never,
    history: never,
    execute: never,
  } as unknown as AutomationClient;
}

// --- Rail ------------------------------------------------------------------

const CLAUDE_ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";

export const CLAUDE_ACCOUNT = decodeProviderInstance({
  id: CLAUDE_ACCOUNT_ID,
  displayName: "Claude Max",
  driverKind: "claude",
  configuration: {
    kind: "claude-agent-sdk",
    binaryPath: "/opt/homebrew/bin/claude",
    authentication: "subscription",
  },
  enabled: true,
  environmentPolicy: "inherit-host",
  version: 1,
  createdAt: VISUAL_NOW,
  updatedAt: VISUAL_NOW,
});

/** A plan reading with 60% of the tightest window left, so the face draws its ring. */
export function planUsageClient(): ProviderUsageLimitsClient {
  const snapshot = decodeProviderUsageLimitsSnapshot({
    version: 1,
    refreshedAt: VISUAL_NOW,
    entries: [
      {
        providerInstanceId: CLAUDE_ACCOUNT_ID,
        status: "available",
        source: "provider-runtime",
        observedAt: VISUAL_NOW,
        limits: {
          providerInstanceId: CLAUDE_ACCOUNT_ID,
          scope: "account",
          requests: { status: "unavailable" },
          tokens: { status: "unavailable" },
          concurrency: { status: "unavailable" },
          retry: { status: "inactive" },
          quota: "available",
          source: "observed-evidence",
          confidence: "high",
          updatedAt: VISUAL_NOW,
          rateLimitWindows: [
            { window: "five_hour", status: "allowed", utilization: 0.4, observedAt: VISUAL_NOW },
          ],
        },
      },
    ],
  });
  return { list: async () => snapshot } as unknown as ProviderUsageLimitsClient;
}

// --- Settings usage --------------------------------------------------------

export const USAGE_LEDGER = {
  records: [
    {
      reconciliationId: "rec-1",
      subject: { aggregateType: "chat-thread", aggregateId: "thread-1" },
      providerInstanceId: "provider-1",
      modelId: "gpt-4o",
      requestShape: "chat-turn",
      quality: "exact",
      inputTokens: 1200,
      outputTokens: 450,
      plannedInputTokens: 1150,
      varianceTokens: 50,
      attribution: [{ category: "conversation", plannedTokens: 1150, quality: "exact" }],
      observedAt: "2026-08-17T12:00:00.000Z",
    },
  ],
  totals: {
    totalInputTokens: 48200,
    totalOutputTokens: 9100,
    totalRequests: 14,
    exactCount: 13,
    estimatedCount: 1,
    reconciledCount: 0,
    staleCount: 0,
    unavailableCount: 0,
  },
  byProvider: [],
  byCategory: [],
  byDay: [
    ["2026-08-14", 8200, 1500, 3],
    ["2026-08-15", 12400, 2300, 4],
    ["2026-08-17", 27600, 5300, 7],
  ].map(([day, input, output, requests]) => ({
    bucketStart: `${String(day)}T00:00:00.000Z`,
    inputTokens: input,
    outputTokens: output,
    requestCount: requests,
    exactCount: requests,
    estimatedCount: 0,
    reconciledCount: 0,
    staleCount: 0,
    unavailableCount: 0,
  })),
  byWeek: [],
  cumulative: [],
  topConsumers: [],
  hasMore: false,
  queryAt: VISUAL_NOW,
  latencyStats: { measurements: [] },
};

// --- Provider usage history ------------------------------------------------

/** Fixed local provider history: two providers over five days, so the chart draws lines. */
export function localUsageHistoryFixture(): LocalUsageHistoryResponse {
  const totalsFor = (tokens: number, sessions: number) => ({
    inputTokens: Math.round(tokens * 0.8),
    outputTokens: Math.round(tokens * 0.2),
    totalTokens: tokens,
    requestCount: sessions * 4,
    sessionCount: sessions,
    cacheReadInputTokens: Math.round(tokens * 0.4),
    uncachedInputTokens: Math.round(tokens * 0.4),
    componentCoverage: {
      uncachedInput: { measured: sessions * 4, total: sessions * 4 },
      cacheRead: { measured: sessions * 4, total: sessions * 4 },
      cacheWrite: { measured: 0, total: sessions * 4 },
      reasoning: { measured: 0, total: sessions * 4 },
    },
  });
  const costFor = (usd: number) => ({
    apiEstimateUsd: usd,
    pricedRecordCount: 4,
    unpricedRecordCount: 0,
  });
  const days = ["2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"];
  const codex = [120_000, 340_000, 90_000, 410_000, 220_000];
  const claude = [80_000, 150_000, 260_000, 120_000, 300_000];
  const dayRows = (providerKey: string, tokens: ReadonlyArray<number>) =>
    days.map((day, index) => ({
      day,
      providerKey,
      totals: totalsFor(tokens[index] ?? 0, 2),
      cost: costFor((tokens[index] ?? 0) / 100_000),
    }));
  const sum = (tokens: ReadonlyArray<number>) => tokens.reduce((total, value) => total + value, 0);
  const provider = (key: string, label: string, tokens: ReadonlyArray<number>) => ({
    key,
    label,
    providerKey: key,
    totals: totalsFor(sum(tokens), 10),
    cost: costFor(sum(tokens) / 100_000),
  });
  return decodeLocalUsageHistoryResponse({
    source: "local-provider-history",
    from: "2026-08-12T00:00:00.000Z",
    to: VISUAL_NOW,
    timeZone: "UTC",
    queryAt: VISUAL_NOW,
    totals: totalsFor(sum(codex) + sum(claude), 20),
    cost: costFor((sum(codex) + sum(claude)) / 100_000),
    providers: [provider("codex", "Codex", codex), provider("claude", "Claude", claude)],
    models: [],
    days: [...dayRows("codex", codex), ...dayRows("claude", claude)],
    dailyTotals: days.map((day, index) => ({
      day,
      providerKey: "all",
      totals: totalsFor((codex[index] ?? 0) + (claude[index] ?? 0), 4),
      cost: costFor(((codex[index] ?? 0) + (claude[index] ?? 0)) / 100_000),
    })),
    coverage: [
      {
        sourceKind: "codex",
        sourceInstallationId: "local-1",
        status: "ready",
        scannedFileCount: 10,
        acceptedRecordCount: 40,
        omittedRecordCount: 0,
        truncated: false,
        hasMore: false,
        detail: "Local Codex sessions on this Mac.",
      },
    ],
  });
}

// --- Subagent progress -----------------------------------------------------

const SUBAGENT_RUN_PREFIX = "0b9d3f40-5a52-4a1e-8c11-00000000000";

function subagentEntry(
  index: number,
  fields: {
    readonly role: string;
    readonly task: string;
    readonly lifecycleStatus: "running" | "completed";
    readonly createdAt: string;
    readonly updatedAt: string;
  },
): AgentHierarchyInputEntry {
  return {
    runId: `${SUBAGENT_RUN_PREFIX}${index}`,
    executionKind: "octant-managed",
    usageQuality: "provider-reported",
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 2,
    ...fields,
  };
}

/** The first turn started at 08:50; every run below began after it. */
export const SUBAGENT_TURN_STARTED_AT = "2026-08-18T08:50:00.000Z";

/** One working (3m 30s so far at the fixed clock) and one finished (48s) child. */
export const SUBAGENT_ROW_ENTRIES: ReadonlyArray<AgentHierarchyInputEntry> = [
  subagentEntry(1, {
    role: "research",
    task: "Map where the composer reads its subagents",
    lifecycleStatus: "running",
    createdAt: "2026-08-18T08:56:30.000Z",
    updatedAt: "2026-08-18T08:59:50.000Z",
  }),
  subagentEntry(2, {
    role: "review",
    task: "Check the retry button against the design",
    lifecycleStatus: "completed",
    createdAt: "2026-08-18T08:52:00.000Z",
    updatedAt: "2026-08-18T08:52:48.000Z",
  }),
];

/** A finished child whose generation-1 delivery shows as a quiet line, worked 1m 12s. */
export const SUBAGENT_RESULT_ENTRY: AgentHierarchyInputEntry = subagentEntry(3, {
  role: "research",
  task: "List the call sites of the retry policy",
  lifecycleStatus: "completed",
  createdAt: "2026-08-18T08:53:00.000Z",
  updatedAt: "2026-08-18T08:54:12.000Z",
});

export const SUBAGENT_RESULT_DELIVERY = [
  "A subagent you delegated has finished.",
  "",
  "Subagent: research (6e1c0f3a-1111-4a7b-9c11-aaaaaaaaaaaa/haiku)",
  `Run: ${SUBAGENT_RUN_PREFIX}3 (generation 1)`,
  "Task: List the call sites of the retry policy",
  "",
  "Result:",
  "Four call sites, all in the server's agent run package.",
].join("\n");

/** Three working children, the first with a title long enough to be cut at 760. */
export const SUBAGENT_TRAY_ENTRIES: ReadonlyArray<AgentHierarchyInputEntry> = [
  subagentEntry(4, {
    role: "research",
    task: "Trace how the folded composer card decides which working subagents to name in its head, and report every place that reads the parent summary",
    lifecycleStatus: "running",
    createdAt: "2026-08-18T08:50:30.000Z",
    updatedAt: "2026-08-18T08:59:00.000Z",
  }),
  subagentEntry(5, {
    role: "implementation",
    task: "Add the run-time slot",
    lifecycleStatus: "running",
    createdAt: "2026-08-18T08:54:00.000Z",
    updatedAt: "2026-08-18T08:59:00.000Z",
  }),
  subagentEntry(6, {
    role: "review",
    task: "Review the diff",
    lifecycleStatus: "running",
    createdAt: "2026-08-18T08:57:00.000Z",
    updatedAt: "2026-08-18T08:59:00.000Z",
  }),
];

/** A host read that has answered with these children and nothing else. */
export function subagentsRead(
  entries: ReadonlyArray<AgentHierarchyInputEntry>,
): ChildRunStatusController {
  return {
    status: "ready",
    entries,
    observations: [],
    observationsTruncated: false,
    summary: buildChildRunStatusSummary(entries),
    reconnecting: false,
    busy: false,
    errorMessage: undefined,
    stopAll: async () => false,
    cancelRun: async () => false,
    acknowledge: async () => undefined,
    refresh: () => undefined,
  };
}
