import { decodeCodeProjectPullRequestView } from "@octant/contracts";

const NOW = "2026-08-10T09:30:00.000Z";
const SITE_PROJECT_ID = "20000000-0000-4000-8000-000000000003";
/** A thread on the computer that this phone's lists do not hold. */
const UNLISTED_THREAD_ID = "60000000-0000-4000-8000-0000000000ff";

interface MockPullRequestIds {
  readonly studioHostId: string;
  readonly travelHostId: string;
  readonly codeProjectId: string;
  readonly codeThreadId: string;
  readonly resumeThreadId: string;
}

type MockRow = Record<string, unknown> & {
  readonly number: number;
  state: string;
  readonly linkedThreads: ReadonlyArray<{ readonly threadId: string; readonly title: string }>;
  babysit?:
    | { readonly threadId: string; readonly status: string; readonly checks?: "all" | "required" }
    | undefined;
  /** Merge when ready, apart from `merging`, which also says it sits in the queue. */
  autoMerge?: boolean;
};

function base(input: {
  readonly projectId: string;
  readonly projectName: string;
  readonly repositoryName: string;
}) {
  return {
    projectId: input.projectId,
    projectName: input.projectName,
    repositoryOwner: "octocat",
    repositoryName: input.repositoryName,
    author: "octocat",
    baseBranch: "main",
    draft: false,
    state: "open",
    mergeability: "mergeable",
    review: "none",
    linkedThreads: [],
  };
}

/**
 * Sample pull requests across two computers, one in each state the phone's
 * list sorts by: a failing one a babysit is fixing, one ready to merge, a draft,
 * one in the merge queue, and one with conflicts and requested changes.
 */
function seedRows(hostId: string, ids: MockPullRequestIds): MockRow[] {
  if (hostId === ids.studioHostId) {
    const octant = base({
      projectId: ids.codeProjectId,
      projectName: "Octant",
      repositoryName: "octant",
    });
    return [
      {
        ...octant,
        number: 812,
        title: "Polish the native mobile review loop",
        headBranch: "feature/issue-812-mobile-polish-mock",
        updatedAt: "2026-08-10T09:20:00Z",
        checks: "passing",
        checkCounts: { passed: 6, total: 6 },
        review: "approved",
        additions: 336,
        deletions: 14,
        linkedThreads: [{ threadId: ids.codeThreadId, title: "Polish the mobile review loop" }],
      },
      {
        ...octant,
        number: 815,
        title: "Speed up the sync worker",
        headBranch: "feature/sync-worker",
        updatedAt: "2026-08-10T09:05:00Z",
        checks: "failing",
        checkCounts: { passed: 4, total: 6 },
        failingChecks: [{ name: "integration (macOS)" }, { name: "typecheck" }],
        review: "pending",
        babysit: { threadId: ids.resumeThreadId, status: "repair-check", checks: "required" },
        linkedThreads: [{ threadId: ids.resumeThreadId, title: "Speed up the sync worker" }],
      },
      {
        ...octant,
        number: 809,
        title: "Move to the next Expo SDK",
        headBranch: "chore/expo-sdk",
        updatedAt: "2026-08-09T16:40:00Z",
        draft: true,
        checks: "pending",
        checkCounts: { passed: 2, total: 6 },
      },
    ];
  }
  if (hostId === ids.travelHostId) {
    const site = base({
      projectId: SITE_PROJECT_ID,
      projectName: "Octant site",
      repositoryName: "octant-site",
    });
    return [
      {
        ...site,
        number: 44,
        title: "Rewrite the pairing guide",
        headBranch: "docs/pairing-guide",
        updatedAt: "2026-08-10T08:50:00Z",
        checks: "passing",
        checkCounts: { passed: 3, total: 3 },
        review: "approved",
        merging: "queued",
      },
      {
        ...site,
        number: 47,
        title: "Fix the dark theme's code colours",
        headBranch: "fix/dark-code-colours",
        updatedAt: "2026-08-10T07:15:00Z",
        checks: "passing",
        mergeability: "conflicting",
        review: "changes-requested",
        // Auto-merge turned on in GitHub itself: Octant holds no switch for it.
        merging: "auto-merge",
        autoMerge: false,
        linkedThreads: [{ threadId: UNLISTED_THREAD_ID, title: "Code colours in dark mode" }],
      },
    ];
  }
  return [];
}

/**
 * One computer's pull-request routes: the list, its refresh, the re-read a
 * merge makes first, the merge, and Merge when ready. As on a computer, the
 * list holds open pull requests only, so a merged one leaves it.
 */
export function createMockPullRequests(hostId: string, ids: MockPullRequestIds) {
  const rows = seedRows(hostId, ids);
  const view = () =>
    decodeCodeProjectPullRequestView({
      version: 1,
      query: { version: 1 },
      projects: [],
      // The demo's own switch state is not part of a listed row.
      rows: rows
        .filter((row) => row.state === "open")
        .map(({ autoMerge: _autoMerge, ...listed }) => listed),
      repositoriesTruncated: false,
      pullRequestsTruncated: false,
      freshness: { status: "fresh", lastSuccessfulRefreshAt: NOW },
      generatedAt: NOW,
    });
  const named = (body: unknown) => {
    const wanted =
      typeof body === "object" && body !== null && "number" in body ? body.number : undefined;
    return rows.find((row) => row.number === wanted);
  };
  return (request: {
    readonly method: string;
    readonly path: string;
    readonly body?: string | Uint8Array;
  }): Response | undefined => {
    if (request.method !== "POST") return undefined;
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    const body: unknown =
      typeof request.body === "string" && request.body.length > 0
        ? JSON.parse(request.body)
        : undefined;
    switch (request.path) {
      case "/api/code/project-pull-requests":
      case "/api/code/project-pull-requests/refresh":
        return json(view());
      case "/api/code/project-pull-requests/detail/refresh": {
        const row = named(body);
        if (row === undefined) return new Response("", { status: 404 });
        return json({
          version: 1,
          query: body,
          detail: {
            state: "observed",
            freshness: "fresh",
            ambiguous: false,
            staleSections: [],
            number: row.number,
            url: `https://github.com/octocat/${String(row.repositoryName)}/pull/${row.number}`,
            title: row.title,
            pullRequestState: row.state === "open" && row.draft === true ? "draft" : row.state,
            baseRepository: `octocat/${String(row.repositoryName)}`,
            baseBranch: row.baseBranch,
            headRepository: `octocat/${String(row.repositoryName)}`,
            headBranch: row.headBranch,
            headSha: "a".repeat(40),
            author: row.author,
            mergeability: row.mergeability,
            matchesDeliveryBranch: false,
            description: "",
            diff: "",
            diffTruncated: false,
            commits: [],
            files: [],
            checks: [],
            reviews: [],
            comments: [],
          },
          freshness: { status: "fresh" },
          linkedThreads: [],
          generatedAt: NOW,
        });
      }
      case "/api/code/project-pull-requests/merge": {
        const row = named(body);
        if (row === undefined) return new Response("", { status: 404 });
        if (row.checks !== "passing" || row.mergeability !== "mergeable") {
          return json({ status: "refused", reason: "checks-not-passing" });
        }
        row.state = "merged";
        return json({ status: "merged", number: row.number, method: "squash", mergedAt: NOW });
      }
      case "/api/code/project-pull-requests/merge-when-ready": {
        const command =
          typeof body === "object" && body !== null && "target" in body ? body : undefined;
        const row = named(command?.target);
        if (command === undefined || row === undefined) return new Response("", { status: 404 });
        row.autoMerge = "kind" in command && command.kind === "enable";
        return json({ status: "applied", view: switches(row) });
      }
      case "/api/code/project-pull-requests/switches": {
        const row = named(body);
        if (row === undefined) return new Response("", { status: 404 });
        return json(switches(row));
      }
      case "/api/code/project-pull-requests/auto-fix": {
        const command =
          typeof body === "object" && body !== null && "target" in body ? body : undefined;
        const row = named(command?.target);
        if (command === undefined || row === undefined) return new Response("", { status: 404 });
        if ("kind" in command && command.kind === "enable") {
          const threadId = "threadId" in command ? String(command.threadId) : "";
          if (!row.linkedThreads.some((thread) => String(thread.threadId) === threadId)) {
            return json({ status: "refused", reason: "thread-not-linked" });
          }
          const checks =
            "babysit" in command &&
            typeof command.babysit === "object" &&
            command.babysit !== null &&
            "checks" in command.babysit &&
            command.babysit.checks === "all"
              ? "all"
              : "required";
          row.babysit = { threadId, status: "checking", checks };
        } else {
          row.babysit = undefined;
        }
        return json({ status: "applied", view: switches(row) });
      }
      default:
        return undefined;
    }
  };
}

/** Babysit and Merge when ready as the computer reports them for one row. */
function switches(row: MockRow) {
  return {
    version: 1,
    target: {
      projectId: row.projectId,
      repositoryOwner: row.repositoryOwner,
      repositoryName: row.repositoryName,
      number: row.number,
    },
    mergeWhenReady:
      (row.autoMerge ?? row.merging === "auto-merge")
        ? { status: "on", method: "squash", enabledAt: NOW, waitingOn: [] }
        : { status: "off" },
    autoFix:
      row.babysit === undefined
        ? { status: "off" }
        : {
            status: "on",
            threadId: row.babysit.threadId,
            enabledAt: NOW,
            babysit: { checks: row.babysit.checks ?? "required" },
          },
    generatedAt: NOW,
  };
}
