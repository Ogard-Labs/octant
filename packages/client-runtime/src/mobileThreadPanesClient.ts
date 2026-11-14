import {
  CodeConversationWindow,
  CodeEnvironmentObservation,
  CodeEvidenceBatchResponse,
  ContextInspectorResult,
  ContextInspectorSnapshot,
  LocalServerCommandResult,
  decodeContextInspectorRequest,
  decodeHostAnswer,
  type CodeBoardCard,
  type CodeOperationCommand,
  type LocalServerSnapshot,
  type TurnMetricsSummary,
} from "@octant/contracts";
import { GitHistoryResult, decodeGitHistoryQuery } from "@octant/contracts/git-history";
import type { GitHistoryPage } from "@octant/contracts/git-history";
import { UsageQueryResponse } from "@octant/contracts/usage-rpc";
import { executeMobileCodeOperation } from "./mobileCodeOperationsClient";
import { fetchMobileCodeBoard, type MobileRemoteTransport } from "./mobileInboxClient";

/*
 * The reads behind the phone's thread panes (Environment, Review, Context &
 * usage, Agents). Every one is a read the host already forwards to a paired
 * device at its own catalogued action; none adds reach. A refusal or an
 * unreadable answer is a value the pane shows in words, never a thrown error.
 */

export type MobilePaneRead<T> =
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "refused" | "unavailable"; readonly message: string };

async function readJson<T>(
  response: Response,
  decode: (value: unknown) => T,
  failure: string,
): Promise<MobilePaneRead<T>> {
  if (!response.ok) {
    return {
      status: response.status === 401 || response.status === 403 ? "refused" : "unavailable",
      message:
        response.status === 401 || response.status === 403
          ? `${failure} This host does not share it with paired devices.`
          : failure,
    };
  }
  try {
    return { status: "ready", value: decode(await response.json()) };
  } catch {
    return { status: "unavailable", message: `${failure} The host returned an invalid answer.` };
  }
}

async function attempt<T>(
  read: () => Promise<MobilePaneRead<T>>,
  failure: string,
): Promise<MobilePaneRead<T>> {
  try {
    return await read();
  } catch {
    return { status: "unavailable", message: failure };
  }
}

export interface MobileThreadScope {
  readonly threadId: string;
  readonly projectId: string;
  readonly checkoutId: string;
}

/** The checkout the Code thread works in: name, branch, folder and uncommitted totals. */
export function loadMobileCodeEnvironment(
  transport: MobileRemoteTransport,
  scope: Pick<MobileThreadScope, "threadId" | "projectId">,
): Promise<MobilePaneRead<CodeEnvironmentObservation>> {
  const failure = "The environment could not be read.";
  return attempt(
    async () =>
      readJson(
        await transport.authenticatedFetch({
          method: "GET",
          path: `/api/projects/${encodeURIComponent(scope.projectId)}/environment`,
          query: `?threadId=${encodeURIComponent(scope.threadId)}`,
        }),
        decodeHostAnswer(CodeEnvironmentObservation),
        failure,
      ),
    failure,
  );
}

/** The listeners the host attributes to this thread's checkout, and leftovers. */
export function loadMobileLocalServers(
  transport: MobileRemoteTransport,
  scope: Pick<MobileThreadScope, "threadId" | "projectId">,
): Promise<MobilePaneRead<LocalServerSnapshot>> {
  const failure = "Local servers could not be read.";
  return attempt(async () => {
    const requestId = crypto.randomUUID();
    const read = await readJson(
      await transport.authenticatedFetch({
        method: "POST",
        path: "/api/code/local-servers/commands",
        body: JSON.stringify({
          kind: "list-local-servers",
          requestId,
          threadId: scope.threadId,
          projectId: scope.projectId,
        }),
      }),
      decodeHostAnswer(LocalServerCommandResult),
      failure,
    );
    if (read.status !== "ready") return read;
    const result = read.value;
    if (result.kind === "local-server-rejected") {
      return { status: "refused", message: result.failure.message };
    }
    if (result.kind !== "local-servers-listed" || String(result.requestId) !== requestId) {
      return { status: "unavailable", message: failure };
    }
    return { status: "ready", value: result.snapshot };
  }, failure);
}

/** The thread's Code board card: its linked pull request and its subagent counts. */
export function loadMobileCodeBoardCard(
  transport: MobileRemoteTransport,
  threadId: string,
): Promise<MobilePaneRead<CodeBoardCard | undefined>> {
  const failure = "The thread's board state could not be read.";
  return attempt(async () => {
    const board = await fetchMobileCodeBoard(transport);
    return {
      status: "ready",
      value: board.cards.find((card) => String(card.threadId) === threadId),
    };
  }, failure);
}

export type MobileDiffLineKind = "hunk" | "added" | "removed" | "context";

export interface MobileDiffLine {
  readonly kind: MobileDiffLineKind;
  readonly text: string;
}

export interface MobileDiffFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  /** True when Git said the file is binary, so there are no lines to show. */
  readonly binary: boolean;
  readonly lines: ReadonlyArray<MobileDiffLine>;
}

/**
 * Splits Git's unified diff into files and counts each file's added and
 * removed lines. Headers (`diff --git`, `index`, `---`, `+++`) are not lines of
 * the file and are not counted, so a `+++` header never reads as an addition.
 */
export function parseMobileUnifiedDiff(text: string): ReadonlyArray<MobileDiffFile> {
  const files: Array<{
    path: string;
    additions: number;
    deletions: number;
    binary: boolean;
    lines: MobileDiffLine[];
  }> = [];
  let current: (typeof files)[number] | undefined;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line);
      current = {
        path: match?.[1] ?? line.slice(11),
        additions: 0,
        deletions: 0,
        binary: false,
        lines: [],
      };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (current === undefined) continue;
    if (!inHunk) {
      if (line.startsWith("+++ ")) {
        const path = line.slice(4);
        if (path.startsWith("b/")) current.path = path.slice(2);
        continue;
      }
      if (line.startsWith("Binary files ")) {
        current.binary = true;
        continue;
      }
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      current.lines.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      current.additions += 1;
      current.lines.push({ kind: "added", text: line });
    } else if (line.startsWith("-")) {
      current.deletions += 1;
      current.lines.push({ kind: "removed", text: line });
    } else if (line.startsWith(" ")) {
      current.lines.push({ kind: "context", text: line });
    }
  }
  return files;
}

export interface MobileWorkingTreeReview {
  readonly branch: string | undefined;
  readonly files: ReadonlyArray<MobileDiffFile>;
  /** The host cut the diff at the phone's byte bound; later files may be missing. */
  readonly truncated: boolean;
}

/** The phone reads at most this much diff text, the bound its pull-request review uses. */
export const MOBILE_REVIEW_DIFF_BYTES = 262_144;

/**
 * The working tree's uncommitted changes, read the way desktop Review reads
 * them: the host observes Git for the thread's checkout and hands back a diff
 * reference, which the evidence batch resolves to text. Observing changes
 * nothing in the checkout.
 */
export function loadMobileWorkingTreeReview(
  transport: MobileRemoteTransport,
  scope: Pick<MobileThreadScope, "threadId" | "checkoutId">,
): Promise<MobilePaneRead<MobileWorkingTreeReview>> {
  const failure = "Uncommitted changes could not be read.";
  return attempt(async () => {
    const operationId = crypto.randomUUID();
    const result = await executeMobileCodeOperation(transport, {
      kind: "observe-git",
      operationId: operationId as CodeOperationCommand["operationId"],
      threadId: scope.threadId as CodeOperationCommand["threadId"],
      checkoutId: scope.checkoutId as CodeOperationCommand["checkoutId"],
      gitOperationId: crypto.randomUUID() as Extract<
        CodeOperationCommand,
        { readonly kind: "observe-git" }
      >["gitOperationId"],
      maxDiffBytes: MOBILE_REVIEW_DIFF_BYTES,
    });
    if (result.kind === "operation-failed") {
      return { status: "refused", message: result.failure.message };
    }
    if (result.kind !== "git-observed") return { status: "unavailable", message: failure };
    const branch = result.head.kind === "branch" ? result.head.name : undefined;
    if (result.diff.byteLength === 0) {
      return { status: "ready", value: { branch, files: [], truncated: false } };
    }
    const batch = await readJson(
      await transport.authenticatedFetch({
        method: "POST",
        path: "/api/code/evidence/batch",
        body: JSON.stringify({
          threadId: scope.threadId,
          items: [{ operationId, contentId: String(result.diff.contentId) }],
        }),
      }),
      decodeHostAnswer(CodeEvidenceBatchResponse),
      failure,
    );
    if (batch.status !== "ready") return batch;
    if (String(batch.value.threadId) !== scope.threadId) {
      return { status: "unavailable", message: failure };
    }
    const text = batch.value.items.find(
      (item) =>
        String(item.operationId) === operationId &&
        String(item.contentId) === String(result.diff.contentId),
    )?.text;
    if (text === undefined) return { status: "unavailable", message: failure };
    return {
      status: "ready",
      value: {
        branch,
        files: parseMobileUnifiedDiff(text),
        truncated: result.diff.truncated === true,
      },
    };
  }, failure);
}

/** The checkout's recent commits, newest first, as desktop Review's History lists them. */
export function loadMobileGitHistory(
  transport: MobileRemoteTransport,
  scope: Pick<MobileThreadScope, "threadId" | "checkoutId">,
): Promise<MobilePaneRead<GitHistoryPage>> {
  const failure = "Git history could not be read.";
  return attempt(async () => {
    const query = decodeGitHistoryQuery({
      kind: "history",
      threadId: scope.threadId,
      checkoutId: scope.checkoutId,
    });
    const read = await readJson(
      await transport.authenticatedFetch({
        method: "GET",
        path: "/api/code/git/history",
        query: `?query=${encodeURIComponent(JSON.stringify(query))}`,
      }),
      decodeHostAnswer(GitHistoryResult),
      failure,
    );
    if (read.status !== "ready") return read;
    const result = read.value;
    if (result.status === "unavailable") return { status: "unavailable", message: result.message };
    if (
      result.status !== "history" ||
      String(result.threadId) !== scope.threadId ||
      String(result.checkoutId) !== scope.checkoutId
    ) {
      return { status: "unavailable", message: failure };
    }
    return { status: "ready", value: result };
  }, failure);
}

/** The thread's recorded turns on any provider, for the shared turn-figures wording. */
export function loadMobileThreadTurnMetrics(
  transport: MobileRemoteTransport,
  threadId: string,
): Promise<MobilePaneRead<TurnMetricsSummary | undefined>> {
  const failure = "Usage could not be read.";
  return attempt(async () => {
    const read = await readJson(
      await transport.authenticatedFetch({
        method: "POST",
        path: "/api/usage/query",
        body: JSON.stringify({ filter: { subjectAggregateId: threadId }, limit: 1 }),
      }),
      decodeHostAnswer(UsageQueryResponse),
      failure,
    );
    return read.status === "ready" ? { status: "ready", value: read.value.turnMetrics } : read;
  }, failure);
}

export type MobileContextMeter =
  | {
      readonly kind: "measured";
      readonly usedTokens: number;
      readonly windowTokens: number;
      /** Where the figure came from, said beside the meter. */
      readonly source: "provider-reported" | "host-planned";
    }
  | { readonly kind: "not-planned" }
  | { readonly kind: "unreported" };

/**
 * How full the thread's context window is. A Code thread's runtime reports
 * its own window with each turn's usage, so the newest turn that reported one
 * is the figure; a Chat or Work thread's window is the host's own plan, read
 * through the context inspector. Nothing is estimated on the phone.
 */
export function loadMobileContextMeter(
  transport: MobileRemoteTransport,
  input: { readonly mode: "chat" | "work" | "code"; readonly threadId: string },
): Promise<MobilePaneRead<MobileContextMeter>> {
  const failure = "Context could not be read.";
  return attempt(async (): Promise<MobilePaneRead<MobileContextMeter>> => {
    if (input.mode === "code") {
      const read = await readJson(
        await transport.authenticatedFetch({
          method: "GET",
          path: `/api/code/threads/${encodeURIComponent(input.threadId)}/conversation/window`,
          query: "?limit=20",
        }),
        decodeHostAnswer(CodeConversationWindow),
        failure,
      );
      if (read.status !== "ready") return read;
      if (String(read.value.threadId) !== input.threadId) {
        return { status: "unavailable", message: failure };
      }
      const reported = [...read.value.turns]
        .reverse()
        .map((turn) => turn.usage)
        .find((usage) => usage?.contextWindow !== undefined && usage.contextTokens !== undefined);
      const usage = reported ?? read.value.earlierUsage;
      if (usage?.contextWindow === undefined || usage.contextTokens === undefined) {
        return { status: "ready", value: { kind: "unreported" } };
      }
      return {
        status: "ready",
        value: {
          kind: "measured",
          usedTokens: usage.contextTokens,
          windowTokens: usage.contextWindow,
          source: "provider-reported",
        },
      };
    }
    const request = decodeContextInspectorRequest({
      subject: {
        aggregateType: input.mode === "chat" ? "chat-thread" : "work-thread",
        aggregateId: input.threadId,
      },
    });
    const read = await readJson(
      await transport.authenticatedFetch({
        method: "POST",
        path: "/api/context/inspect",
        body: JSON.stringify(request),
      }),
      decodeInspectorAnswer,
      failure,
    );
    if (read.status !== "ready") return read;
    const result = read.value;
    const subject = result.kind === "snapshot" ? result.snapshot.subject : result.subject;
    if (String(subject.aggregateId) !== input.threadId) {
      return { status: "unavailable", message: failure };
    }
    if (result.kind === "not-planned") return { status: "ready", value: { kind: "not-planned" } };
    const snapshot = result.snapshot;
    const reportedTokens = snapshot.latestUsage?.contextTokens;
    return {
      status: "ready",
      value: {
        kind: "measured",
        usedTokens: reportedTokens ?? snapshot.next.plan.plannedInputTokens,
        windowTokens: snapshot.latestUsage?.contextWindow ?? snapshot.modelLimits.contextWindow,
        source: reportedTokens === undefined ? "host-planned" : "provider-reported",
      },
    };
  }, failure);
}

/** The inspector answers a result with a `kind`, or a bare snapshot from an older host. */
function decodeInspectorAnswer(input: unknown): ContextInspectorResult {
  if (typeof input === "object" && input !== null && "kind" in input) {
    return decodeHostAnswer(ContextInspectorResult)(input);
  }
  return { kind: "snapshot", snapshot: decodeHostAnswer(ContextInspectorSnapshot)(input) };
}
