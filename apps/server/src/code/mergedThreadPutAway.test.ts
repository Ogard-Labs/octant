import type {
  CodeThread,
  CodeThreadId,
  CodeThreadLinkedPullRequest,
  CodeThreadOperationalMetadataView,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { MergedThreadPutAwayOutcome } from "./codeService";
import { MergedThreadPutAway, type MergedPullRequest } from "./mergedThreadPutAway";

const merged: CodeThreadLinkedPullRequest = {
  kind: "linked",
  freshness: "fresh",
  number: 42,
  url: "https://github.com/acme/app/pull/42" as Extract<
    CodeThreadLinkedPullRequest,
    { kind: "linked" }
  >["url"],
  baseRepository: "acme/app",
  baseBranch: "main",
  headBranch: "feature/thing",
  state: "merged",
  matchesDeliveryBranch: true,
};

function codeThread(id: string, extra: Partial<CodeThread> = {}): CodeThread {
  return {
    id: id as CodeThreadId,
    projectId: "project-1",
    lifecycle: "active",
    ...extra,
  } as CodeThread;
}

function fixture(options: {
  readonly threads: ReadonlyArray<CodeThread>;
  readonly evidence: Readonly<
    Record<
      string,
      {
        readonly linkedPullRequest: CodeThreadLinkedPullRequest;
        readonly childAgentsActive?: number;
      }
    >
  >;
  readonly cachedMerges?: Readonly<Record<string, ReadonlyArray<MergedPullRequest>>>;
  readonly decisionPending?: ReadonlyArray<string>;
  readonly enabled?: boolean;
}) {
  const putAway = vi.fn((): MergedThreadPutAwayOutcome => ({ status: "put-away" }));
  const project = vi.fn(async (entries: ReadonlyArray<{ readonly thread: CodeThread }>) => {
    const threadId = entries[0]?.thread.id;
    const evidence = threadId === undefined ? undefined : options.evidence[String(threadId)];
    return {
      version: 1,
      threads:
        evidence === undefined
          ? []
          : [
              {
                threadId,
                linkedPullRequest: evidence.linkedPullRequest,
                childAgents: { active: evidence.childAgentsActive ?? 0, unacknowledgedResults: 0 },
              },
            ],
    } as unknown as CodeThreadOperationalMetadataView;
  });
  const pass = new MergedThreadPutAway({
    threads: () => options.threads,
    projectExists: () => true,
    metadata: { project },
    cachedMerges: (threadId) => options.cachedMerges?.[String(threadId)] ?? [],
    decisionPending: (thread) => options.decisionPending?.includes(String(thread.id)) === true,
    samePullRequest: (_projectId, left, right) =>
      left.number === right.number && left.baseRepository === right.baseRepository,
    putAway,
    enabled: () => options.enabled ?? true,
  });
  return { pass, putAway, project };
}

describe("merged thread put-away", () => {
  it("puts away a thread whose pull request merged, and leaves an open one, an unmerged one and a coordinator", async () => {
    const { pass, putAway } = fixture({
      threads: [
        codeThread("merged"),
        codeThread("open"),
        codeThread("investigated"),
        codeThread("coordinator", { coordinator: true }),
        codeThread("archived", { lifecycle: "archived" }),
      ],
      evidence: {
        merged: { linkedPullRequest: merged },
        open: {
          linkedPullRequest: { ...merged, state: "open" },
        },
        investigated: {
          linkedPullRequest: { kind: "none", freshness: "fresh" },
        },
        coordinator: { linkedPullRequest: merged },
        archived: { linkedPullRequest: merged },
      },
    });

    expect(await pass.pass()).toEqual(["merged"]);
    expect(putAway).toHaveBeenCalledTimes(1);
    expect(putAway).toHaveBeenCalledWith(
      "merged",
      [{ baseRepository: "acme/app", number: 42 }],
      expect.any(Function),
    );
  });

  it("puts a thread away for a merge only the Pull requests refresh saw, with the thread's history still open", async () => {
    const { pass, putAway } = fixture({
      threads: [codeThread("refreshed")],
      evidence: { refreshed: { linkedPullRequest: { ...merged, state: "open" } } },
      cachedMerges: { refreshed: [{ baseRepository: "acme/app", number: 42 }] },
    });

    expect(await pass.pass()).toEqual(["refreshed"]);
    expect(putAway).toHaveBeenCalledWith(
      "refreshed",
      [{ baseRepository: "acme/app", number: 42 }],
      expect.any(Function),
    );
  });

  it("keeps a merged thread in view while a decision waits on the person or its child work is unfinished", async () => {
    const { pass, putAway } = fixture({
      threads: [codeThread("deciding"), codeThread("delegating")],
      evidence: {
        deciding: { linkedPullRequest: merged },
        delegating: { linkedPullRequest: merged, childAgentsActive: 1 },
      },
      decisionPending: ["deciding"],
    });

    expect(await pass.pass()).toEqual([]);
    expect(putAway).not.toHaveBeenCalled();
  });

  it("does not put a thread away again for the pull request it was already put away for", async () => {
    const { pass, putAway } = fixture({
      threads: [
        codeThread("taken-back", {
          putAwayForPullRequests: [{ baseRepository: "acme/app", number: 42 }],
        }),
      ],
      evidence: { "taken-back": { linkedPullRequest: merged } },
    });

    expect(await pass.pass()).toEqual([]);
    expect(putAway).not.toHaveBeenCalled();
  });

  it("puts a taken-back thread away when a lower-numbered pull request merges later", async () => {
    const { pass, putAway } = fixture({
      threads: [
        codeThread("taken-back", {
          putAwayForPullRequests: [{ baseRepository: "acme/app", number: 42 }],
        }),
      ],
      evidence: { "taken-back": { linkedPullRequest: merged } },
      cachedMerges: { "taken-back": [{ baseRepository: "acme/app", number: 41 }] },
    });

    expect(await pass.pass()).toEqual(["taken-back"]);
    expect(putAway).toHaveBeenCalledWith(
      "taken-back",
      [
        { baseRepository: "acme/app", number: 42 },
        { baseRepository: "acme/app", number: 41 },
      ],
      expect.any(Function),
    );
  });

  it("does not put a taken-back thread away again when a sign-out empties the refresh cache and an older merge remains", async () => {
    const { pass, putAway } = fixture({
      threads: [
        codeThread("taken-back", {
          putAwayForPullRequests: [
            { baseRepository: "acme/app", number: 41 },
            { baseRepository: "acme/app", number: 42 },
          ],
        }),
      ],
      evidence: { "taken-back": { linkedPullRequest: { ...merged, number: 41 } } },
    });

    expect(await pass.pass()).toEqual([]);
    expect(putAway).not.toHaveBeenCalled();
  });

  it("reads and writes nothing while the person has the setting off", async () => {
    const { pass, putAway, project } = fixture({
      threads: [codeThread("merged")],
      evidence: { merged: { linkedPullRequest: merged } },
      enabled: false,
    });

    expect(await pass.pass()).toEqual([]);
    expect(project).not.toHaveBeenCalled();
    expect(putAway).not.toHaveBeenCalled();
  });
});
