import type {
  CodeThread,
  CodeThreadId,
  CodeThreadLinkedPullRequest,
  CodeThreadOperationalMetadataView,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { MergedThreadPutAwayOutcome } from "./codeService";
import { MergedThreadPutAway } from "./mergedThreadPutAway";

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
        readonly deliverySatisfaction: "pending" | "waiting" | "done";
        readonly linkedPullRequest: CodeThreadLinkedPullRequest;
      }
    >
  >;
  readonly enabled?: boolean;
}) {
  const putAway = vi.fn((): MergedThreadPutAwayOutcome => ({ status: "put-away" }));
  const project = vi.fn(async (entries: ReadonlyArray<{ readonly thread: CodeThread }>) => {
    const threadId = entries[0]?.thread.id;
    const evidence = threadId === undefined ? undefined : options.evidence[String(threadId)];
    return {
      version: 1,
      threads: evidence === undefined ? [] : [{ threadId, ...evidence }],
    } as unknown as CodeThreadOperationalMetadataView;
  });
  const pass = new MergedThreadPutAway({
    threads: () => options.threads,
    projectExists: () => true,
    metadata: { project },
    putAway,
    enabled: () => options.enabled ?? true,
  });
  return { pass, putAway, project };
}

describe("merged thread put-away", () => {
  it("puts away a Done thread whose pull request merged, and leaves an open one, an unmerged Done one and a coordinator", async () => {
    const { pass, putAway } = fixture({
      threads: [
        codeThread("merged"),
        codeThread("open"),
        codeThread("investigated"),
        codeThread("coordinator", { coordinator: true }),
        codeThread("archived", { lifecycle: "archived" }),
      ],
      evidence: {
        merged: { deliverySatisfaction: "done", linkedPullRequest: merged },
        open: {
          deliverySatisfaction: "done",
          linkedPullRequest: { ...merged, state: "open" },
        },
        investigated: {
          deliverySatisfaction: "done",
          linkedPullRequest: { kind: "none", freshness: "fresh" },
        },
        coordinator: { deliverySatisfaction: "done", linkedPullRequest: merged },
        archived: { deliverySatisfaction: "done", linkedPullRequest: merged },
      },
    });

    expect(await pass.pass()).toEqual(["merged"]);
    expect(putAway).toHaveBeenCalledTimes(1);
    expect(putAway).toHaveBeenCalledWith("merged", { baseRepository: "acme/app", number: 42 });
  });

  it("does not put a thread away again for the pull request it was already put away for", async () => {
    const { pass, putAway } = fixture({
      threads: [
        codeThread("taken-back", {
          putAwayForPullRequest: { baseRepository: "acme/app", number: 42 },
        }),
      ],
      evidence: { "taken-back": { deliverySatisfaction: "done", linkedPullRequest: merged } },
    });

    expect(await pass.pass()).toEqual([]);
    expect(putAway).not.toHaveBeenCalled();
  });

  it("reads and writes nothing while the person has the setting off", async () => {
    const { pass, putAway, project } = fixture({
      threads: [codeThread("merged")],
      evidence: { merged: { deliverySatisfaction: "done", linkedPullRequest: merged } },
      enabled: false,
    });

    expect(await pass.pass()).toEqual([]);
    expect(project).not.toHaveBeenCalled();
    expect(putAway).not.toHaveBeenCalled();
  });
});
