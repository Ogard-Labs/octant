/*
 * The mock host's answers for the reads behind the phone's thread panes
 * (Environment, Review, Context & usage, Agents), so a web preview draws each
 * pane with realistic content. Shapes follow the host's own contracts.
 */

const NOW = "2026-08-10T09:30:00.000Z";
const EARLIER = "2026-08-10T08:45:00.000Z";

export const MOCK_WORKING_TREE_DIFF = [
  "diff --git a/apps/mobile/src/panes/ThreadPanesSheet.tsx b/apps/mobile/src/panes/ThreadPanesSheet.tsx",
  "index 1a2b3c4..5d6e7f8 100644",
  "--- a/apps/mobile/src/panes/ThreadPanesSheet.tsx",
  "+++ b/apps/mobile/src/panes/ThreadPanesSheet.tsx",
  "@@ -12,7 +12,9 @@ export function ThreadPanesSheet(props: ThreadPanesSheetProps) {",
  "   const panes = useMemo(() => listMobileThreadPanes(props.mode), [props.mode]);",
  '-  const [pane, setPane] = useState("context");',
  "+  const [pane, setPane] = useState<MobileThreadPaneId>(",
  '+    panes[0]?.id ?? "context",',
  "+  );",
  "   return (",
  "     <BottomSheet title={PANE_TITLES[pane]} visible={props.visible}>",
  "diff --git a/apps/mobile/src/inbox/ThreadScreen.tsx b/apps/mobile/src/inbox/ThreadScreen.tsx",
  "index 9f8e7d6..c5b4a39 100644",
  "--- a/apps/mobile/src/inbox/ThreadScreen.tsx",
  "+++ b/apps/mobile/src/inbox/ThreadScreen.tsx",
  "@@ -88,6 +88,7 @@ export function ThreadScreen(props: ThreadScreenProps) {",
  "   const [attachOpen, setAttachOpen] = useState(false);",
  "+  const [panesOpen, setPanesOpen] = useState(false);",
  '   const [surface, setSurface] = useState<RemoteThreadSurfaceKind>("chat");',
  "diff --git a/docs/design/mobile-maturity.md b/docs/design/mobile-maturity.md",
  "index 0a1b2c3..4d5e6f7 100644",
  "--- a/docs/design/mobile-maturity.md",
  "+++ b/docs/design/mobile-maturity.md",
  "@@ -126,3 +126,4 @@",
  " | Modes and approvals | ... |",
  "-| Hardening ports     | ... |",
  "+| Thread panes        | ... |",
  "+| Hardening ports     | ... |",
].join("\n");

export function mockCodeEnvironment(input: {
  readonly projectId: string;
  readonly threadId: string;
  readonly checkoutId: string;
}) {
  return {
    status: "ready",
    projectId: input.projectId,
    projectName: "Octant",
    observedAt: NOW,
    threadId: input.threadId,
    checkoutId: input.checkoutId,
    repositoryRoot: "/mock/octant",
    worktreeRoot: "/mock/octant/.worktrees/mobile-thread-panes",
    branch: { kind: "named", name: "feature/issue-812-mobile-polish-mock" },
    changes: "dirty",
    insertions: 6,
    deletions: 2,
  } as const;
}

export function mockLocalServers(input: {
  readonly requestId: string;
  readonly projectId: string;
  readonly threadId: string;
}) {
  return {
    kind: "local-servers-listed",
    requestId: input.requestId,
    snapshot: {
      threadId: input.threadId,
      projectId: input.projectId,
      currentCheckout: [
        {
          listenerId: `lsn_${"1".repeat(32)}`,
          port: 8112,
          url: "http://127.0.0.1:8112/",
          processName: "node",
          framework: "expo",
          attribution: "current-checkout",
          startSource: "octant",
          bindScope: "loopback",
          health: "listening",
          openAvailable: true,
          stop: { status: "unavailable", reason: "Stopping stays on the Mac." },
        },
      ],
      other: [],
      observedAt: NOW,
    },
  } as const;
}

export function mockGitHistory(input: { readonly threadId: string; readonly checkoutId: string }) {
  const commit = (seed: string, subject: string, author: string, authoredAt: string) => ({
    oid: seed.repeat(40),
    parents: [],
    subject,
    author,
    authoredAt,
  });
  return {
    status: "history",
    threadId: input.threadId,
    checkoutId: input.checkoutId,
    commits: [
      commit("a", "feat(mobile): add safe mock review mode", "octocat", "2026-08-10T08:40:00Z"),
      commit(
        "b",
        "fix(mobile): keep the composer above the keyboard",
        "octocat",
        "2026-08-09T17:12:00Z",
      ),
      commit("c", "docs: record the phone's review loop", "reviewer", "2026-08-09T11:03:00Z"),
    ],
    refs: [],
    head: "a".repeat(40),
    branch: "feature/issue-812-mobile-polish-mock",
    shallow: false,
    refsTruncated: false,
    nextCursor: null,
  } as const;
}

export function mockUsageQuery(input: {
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
}) {
  const turn = (startedAt: string, endedAt: string, input_: number, output: number) => ({
    threadId: input.threadId,
    mode: "code",
    providerInstanceId: input.providerInstanceId,
    modelId: input.modelId,
    stopReason: "end-of-turn",
    usage: { inputTokens: input_, outputTokens: output, cacheReadInputTokens: input_ - 4_000 },
    metrics: {
      precision: "exact",
      wallMs: 48_000,
      timeToFirstTokenMs: 1_400,
      decodeOutputTokens: output,
      decodeMs: 30_000,
      toolMs: 16_000,
      modelCalls: 3,
    },
    startedAt,
    endedAt,
  });
  return {
    records: [],
    totals: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
      exactCount: 0,
      estimatedCount: 0,
      reconciledCount: 0,
      staleCount: 0,
      unavailableCount: 0,
    },
    byProvider: [],
    byCategory: [],
    byDay: [],
    byWeek: [],
    cumulative: [],
    topConsumers: [],
    hasMore: false,
    queryAt: NOW,
    turnMetrics: {
      turns: [
        turn(EARLIER, "2026-08-10T08:46:00.000Z", 38_000, 1_200),
        turn("2026-08-10T09:20:00.000Z", "2026-08-10T09:21:00.000Z", 41_000, 1_800),
      ],
      turnCount: 2,
      usage: { inputTokens: 79_000, outputTokens: 3_000, cacheReadInputTokens: 71_000 },
      metrics: {
        turns: 2,
        measuredTurns: 2,
        precision: "exact",
        decodeOutputTokens: 3_000,
        decodeMs: 60_000,
        toolMs: 32_000,
        timeToFirstTokenTotalMs: 2_800,
      },
    },
  } as const;
}
