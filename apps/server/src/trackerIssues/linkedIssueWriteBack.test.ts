import type { CodeThread, ThreadLinkedIssue } from "@octant/contracts";
import { MERGE_WHEN_READY_OFFER } from "@octant/domain/code-pull-request-switch-policy";
import { describe, expect, it, vi } from "vitest";
import { LinkedIssueWriteBack, type LinkedThreadPullRequest } from "./linkedIssueWriteBack";

const thread = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as unknown as CodeThread;
const linked: ReadonlyArray<ThreadLinkedIssue> = [
  {
    issue: { forge: "linear", identifier: "ENG-7", issueId: "lin-1" },
    source: "created-from",
    linkedAt: "2026-11-26T12:00:00.000Z" as ThreadLinkedIssue["linkedAt"],
  },
];

function writeBack(input: {
  readonly keepCurrent: boolean;
  readonly pullRequest?: LinkedThreadPullRequest;
}) {
  const advance = vi.fn(
    async (..._args: ReadonlyArray<unknown>): Promise<ReadonlyArray<never>> => [],
  );
  const tell = vi.fn(async () => undefined);
  const offer = vi.fn(async () => undefined);
  const service = new LinkedIssueWriteBack({
    writes: { advance },
    linked: () => linked,
    threads: () => [thread],
    readThread: () => thread,
    keepCurrent: () => input.keepCurrent,
    pullRequest: async () => input.pullRequest,
    tell,
    offer,
  });
  return { service, advance, tell, offer };
}

const open: LinkedThreadPullRequest = {
  state: "open",
  url: "https://github.com/acme/app/pull/9",
  number: 9,
  baseRepository: "acme/app",
};

describe("LinkedIssueWriteBack", () => {
  it("with the switch off, nothing is written", async () => {
    const { service, advance } = writeBack({ keepCurrent: false, pullRequest: open });
    await service.onTurnStarted(String(thread.id));
    await service.pass();
    const merged = writeBack({ keepCurrent: false, pullRequest: { ...open, state: "merged" } });
    await merged.service.pass();
    expect(advance).not.toHaveBeenCalled();
    expect(merged.advance).not.toHaveBeenCalled();
  });

  it("moves linked issues at a turn's start, an open pull request, and its merge", async () => {
    const started = writeBack({ keepCurrent: true });
    await started.service.onTurnStarted(String(thread.id));
    expect(started.advance).toHaveBeenCalledWith(String(thread.id), "in-progress", undefined, {
      retry: true,
    });

    const reviewing = writeBack({ keepCurrent: true, pullRequest: open });
    await reviewing.service.pass();
    expect(reviewing.advance).toHaveBeenCalledWith(String(thread.id), "in-review", undefined, {
      retry: false,
    });

    const opened = writeBack({ keepCurrent: true });
    await opened.service.onPullRequestCreated(String(thread.id));
    expect(opened.advance).toHaveBeenCalledWith(String(thread.id), "in-review", undefined, {
      retry: true,
    });

    const merged = writeBack({ keepCurrent: true, pullRequest: { ...open, state: "merged" } });
    await merged.service.pass();
    expect(merged.advance).toHaveBeenCalledWith(String(thread.id), "done", open.url, {
      retry: false,
      requireEarlierWrite: true,
    });
  });

  it("offers Merge when ready on a linked thread's open pull request, which the person turns on", async () => {
    const { service, offer } = writeBack({ keepCurrent: false, pullRequest: open });
    await service.pass();
    await service.pass();
    // Offered once: a person who dismissed it is not asked again every pass.
    expect(offer).toHaveBeenCalledOnce();
    expect(offer).toHaveBeenCalledWith(
      String(thread.id),
      "acme/app#9",
      `acme/app#9 ${MERGE_WHEN_READY_OFFER}`,
    );
  });

  it("a turn the person starts lets the next pass retry a refused moment", async () => {
    const { service, advance } = writeBack({ keepCurrent: true, pullRequest: open });
    await service.onTurnStarted(String(thread.id));
    await service.pass();
    await service.pass();
    expect(
      advance.mock.calls.filter((call) => call[1] === "in-review").map((call) => call[3]),
    ).toEqual([{ retry: true }, { retry: false }]);
  });
});
