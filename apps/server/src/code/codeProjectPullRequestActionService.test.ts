import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  decodeProjectId,
  decodeUtcTimestamp,
  decodeWindowId,
  type CodeProjectPullRequestActionCommand,
  type CodeProjectPullRequestMergeOutcome,
} from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  CodeProjectPullRequestActionService,
  journalPullRequestAction,
  type CodeProjectPullRequestActionForge,
} from "./codeProjectPullRequestActionService";

const now = "2026-10-31T12:00:00.000Z";
const mergedAt = decodeUtcTimestamp(now);
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const otherProjectId = decodeProjectId("10000000-0000-4000-8000-000000000003");
const target = {
  projectId,
  repositoryOwner: "octant",
  repositoryName: "octant",
  number: 12,
} as const;
const signal = () => new AbortController().signal;

function openJournal() {
  const directory = mkdtempSync(join(tmpdir(), "octant-pull-request-actions-"));
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  return {
    journal,
    recorded: () =>
      journal
        .replay({ afterSequence: 0 as never, limit: 1000 })
        .filter((event) => event.eventName === "code.project-pull-request-action-recorded@1"),
    close: () => {
      connection.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function fixture(
  options: {
    readonly forge?: Partial<CodeProjectPullRequestActionForge>;
    readonly authorized?: "authorized" | "not-authorized" | "disconnected";
    readonly merge?: (number: number) => CodeProjectPullRequestMergeOutcome;
    readonly summaries?: Record<
      number,
      { state: "open" | "closed" | "merged"; headBranch: string; baseBranch: string }
    >;
  } = {},
) {
  const store = openJournal();
  const done = { status: "done" } as const;
  const forge = {
    editLabels: vi.fn(options.forge?.editLabels ?? (async () => done)),
    comment: vi.fn(options.forge?.comment ?? (async () => done)),
    replyToReviewThread: vi.fn(options.forge?.replyToReviewThread ?? (async () => done)),
    retarget: vi.fn(options.forge?.retarget ?? (async () => done)),
    setState: vi.fn(options.forge?.setState ?? (async () => done)),
    summary: vi.fn(
      options.forge?.summary ??
        (async (request: { readonly number: number }) => {
          const summary = options.summaries?.[request.number];
          return summary === undefined
            ? ({ status: "unavailable" } as const)
            : ({ status: "read", headSha: "a".repeat(40), ...summary } as const);
        }),
    ),
  };
  const authority = {
    authorizePullRequest: vi.fn(async () =>
      options.authorized === "not-authorized"
        ? ({ status: "not-authorized" } as const)
        : options.authorized === "disconnected"
          ? ({ status: "disconnected" } as const)
          : ({ status: "authorized", linkedThreadIds: [] } as const),
    ),
  };
  const merge = vi.fn(
    async (
      _window: unknown,
      command: { readonly number: number },
      _signal: AbortSignal,
      _caller: "local-window" | "remote-device",
    ) =>
      options.merge?.(command.number) ??
      ({
        status: "merged",
        number: command.number,
        method: "squash",
        mergedAt,
      } as const),
  );
  const service = new CodeProjectPullRequestActionService({
    authority,
    forge,
    merge,
    record: (record) =>
      journalPullRequestAction(store.journal, record, {
        uuid: () => crypto.randomUUID(),
        clock: () => now,
      }),
  });
  return { service, forge, authority, merge, store };
}

describe("project pull-request actions", () => {
  it.each([
    [
      { kind: "labels", ...target, add: ["bug"], remove: ["wip"] },
      "editLabels",
      { owner: "octant", name: "octant", number: 12, add: ["bug"], remove: ["wip"] },
    ],
    [
      { kind: "comment", ...target, body: "Thanks." },
      "comment",
      { owner: "octant", name: "octant", number: 12, body: "Thanks." },
    ],
    [
      { kind: "reply", ...target, reviewThreadId: "PRRT_1", body: "Fixed." },
      "replyToReviewThread",
      { owner: "octant", name: "octant", number: 12, threadNodeId: "PRRT_1", body: "Fixed." },
    ],
    [
      { kind: "close", ...target },
      "setState",
      { owner: "octant", name: "octant", number: 12, state: "closed" },
    ],
    [
      { kind: "reopen", ...target },
      "setState",
      { owner: "octant", name: "octant", number: 12, state: "open" },
    ],
  ] as const)(
    "does a %j for the local user and journals it once",
    async (command, method, call) => {
      const { service, forge, store } = fixture();
      try {
        const outcome = await service.act(
          windowId,
          command as CodeProjectPullRequestActionCommand,
          signal(),
          "local-window",
        );
        expect(outcome).toEqual({ status: "done" });
        expect(forge[method]).toHaveBeenCalledWith(call, expect.any(AbortSignal));
        const events = store.recorded();
        expect(events).toHaveLength(1);
        expect(events[0]?.actor.kind).toBe("local-user");
        expect(events[0]?.payload).toMatchObject({
          number: 12,
          action: command.kind,
          result: { status: "done" },
        });
      } finally {
        store.close();
      }
    },
  );

  it("journals a comment's length and never its text", async () => {
    const { service, store } = fixture();
    try {
      await service.act(
        windowId,
        { kind: "comment", ...target, body: "secret plan for the release" },
        signal(),
        "local-window",
      );
      const text = JSON.stringify(store.recorded());
      expect(text).not.toContain("secret plan");
      expect(store.recorded()[0]?.payload).toMatchObject({ bodyBytes: 27 });
    } finally {
      store.close();
    }
  });

  it("refuses a paired device before looking at the Project, and keeps the refusal", async () => {
    const { service, forge, authority, store } = fixture();
    try {
      const outcome = await service.act(
        windowId,
        { kind: "close", ...target },
        signal(),
        "remote-device",
      );
      expect(outcome).toEqual({ status: "refused", reason: "not-authorized" });
      expect(authority.authorizePullRequest).not.toHaveBeenCalled();
      expect(forge.setState).not.toHaveBeenCalled();
      expect(store.recorded().map((event) => event.payload)).toMatchObject([
        { action: "close", result: { status: "refused", reason: "not-authorized" } },
      ]);
    } finally {
      store.close();
    }
  });

  it("refuses a Project that does not connect the repository and reports a signed-out GitHub as unavailable", async () => {
    const stranger = fixture({ authorized: "not-authorized" });
    const revoked = fixture({ authorized: "disconnected" });
    try {
      const command = { kind: "comment", ...target, projectId: otherProjectId, body: "x" } as const;
      expect(await stranger.service.act(windowId, command, signal(), "local-window")).toEqual({
        status: "refused",
        reason: "not-authorized",
      });
      expect(await revoked.service.act(windowId, command, signal(), "local-window")).toEqual({
        status: "unavailable",
        reason: "disconnected",
      });
      expect(stranger.forge.comment).not.toHaveBeenCalled();
      expect(revoked.forge.comment).not.toHaveBeenCalled();
      expect(stranger.store.recorded()).toHaveLength(1);
      expect(revoked.store.recorded()).toHaveLength(1);
    } finally {
      stranger.store.close();
      revoked.store.close();
    }
  });

  it("passes the forge's honest refusal through and journals it", async () => {
    const { service, store } = fixture({
      forge: { setState: async () => ({ status: "refused", reason: "merged" }) },
    });
    try {
      expect(
        await service.act(windowId, { kind: "reopen", ...target }, signal(), "local-window"),
      ).toEqual({ status: "refused", reason: "merged" });
      expect(store.recorded()[0]?.payload).toMatchObject({
        result: { status: "refused", reason: "merged" },
      });
    } finally {
      store.close();
    }
  });

  it("records the attempt as failed, without the error text, when the forge call throws", async () => {
    const { service, store } = fixture({
      forge: {
        comment: async () => {
          throw new Error("https://user:ghp_secret@github.com");
        },
      },
    });
    try {
      await expect(
        service.act(windowId, { kind: "comment", ...target, body: "x" }, signal(), "local-window"),
      ).rejects.toThrow();
      expect(store.recorded()).toHaveLength(1);
      expect(JSON.stringify(store.recorded())).not.toContain("ghp_secret");
    } finally {
      store.close();
    }
  });
});

describe("stack merge", () => {
  const command = (numbers: ReadonlyArray<number>) =>
    ({
      projectId,
      repositoryOwner: "octant",
      repositoryName: "octant",
      method: "squash",
      confirmed: true,
      items: numbers.map((number) => ({ number, headSha: "a".repeat(40) })),
    }) as const;
  const chain = {
    1: { state: "open", headBranch: "a", baseBranch: "main" },
    2: { state: "open", headBranch: "b", baseBranch: "a" },
    3: { state: "open", headBranch: "c", baseBranch: "b" },
  } as const;

  it("merges a chain from the bottom, one at a time, as the caller who asked", async () => {
    const { service, merge, store } = fixture({ summaries: chain });
    try {
      expect(
        await service.mergeStack(windowId, command([1, 2, 3]), signal(), "remote-device"),
      ).toEqual({
        status: "merged",
        merged: [1, 2, 3],
      });
      expect(merge.mock.calls.map(([, merged, , caller]) => [merged.number, caller])).toEqual([
        [1, "remote-device"],
        [2, "remote-device"],
        [3, "remote-device"],
      ]);
      expect(merge.mock.calls[0]?.[1]).toMatchObject({ confirmed: true, headSha: "a".repeat(40) });
    } finally {
      store.close();
    }
  });

  it("points each child at the branch the stack lands on before merging it", async () => {
    const { service, forge, merge, store } = fixture({ summaries: chain });
    try {
      await service.mergeStack(windowId, command([1, 2, 3]), signal(), "local-window");
      expect(
        forge.retarget.mock.calls.map(([request]) => [request.number, request.baseBranch]),
      ).toEqual([
        [2, "main"],
        [3, "main"],
      ]);
      expect(forge.retarget.mock.invocationCallOrder[0]).toBeLessThan(
        merge.mock.invocationCallOrder[1] ?? 0,
      );
    } finally {
      store.close();
    }
  });

  it("stops before merging a child it could not retarget", async () => {
    const { service, merge, store } = fixture({
      summaries: chain,
      forge: { retarget: async () => ({ status: "refused", reason: "failed" }) },
    });
    try {
      expect(await service.mergeStack(windowId, command([1, 2]), signal(), "local-window")).toEqual(
        {
          status: "stopped",
          merged: [1],
          stoppedAt: 2,
          outcome: { status: "unavailable", reason: "unavailable" },
        },
      );
      expect(merge).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("refuses a stack that is not one chain before merging anything", async () => {
    const { service, merge, store } = fixture({
      summaries: { ...chain, 3: { state: "open", headBranch: "c", baseBranch: "main" } },
    });
    try {
      expect(
        await service.mergeStack(windowId, command([1, 2, 3]), signal(), "local-window"),
      ).toEqual({
        status: "refused",
        reason: "not-a-chain",
      });
      expect(await service.mergeStack(windowId, command([1, 1]), signal(), "local-window")).toEqual(
        {
          status: "refused",
          reason: "duplicate",
        },
      );
      expect(merge).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("refuses a stack with a closed or unreadable member before merging anything", async () => {
    const { service, merge, store } = fixture({
      summaries: { ...chain, 2: { state: "closed", headBranch: "b", baseBranch: "a" } },
    });
    try {
      expect(await service.mergeStack(windowId, command([1, 2]), signal(), "local-window")).toEqual(
        {
          status: "refused",
          reason: "unreadable",
        },
      );
      expect(await service.mergeStack(windowId, command([1, 9]), signal(), "local-window")).toEqual(
        {
          status: "refused",
          reason: "unreadable",
        },
      );
      expect(merge).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("refuses a pull request outside the connected repository before reading any", async () => {
    const { service, forge, merge, store } = fixture({
      authorized: "not-authorized",
      summaries: chain,
    });
    try {
      expect(await service.mergeStack(windowId, command([1, 2]), signal(), "local-window")).toEqual(
        {
          status: "refused",
          reason: "not-authorized",
        },
      );
      expect(forge.summary).not.toHaveBeenCalled();
      expect(merge).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("stops at the first pull request that does not merge and says what landed", async () => {
    const { service, merge, store } = fixture({
      summaries: chain,
      merge: (number) =>
        number === 2
          ? { status: "refused", reason: "checks-not-passing" }
          : { status: "merged", number, method: "squash", mergedAt },
    });
    try {
      expect(
        await service.mergeStack(windowId, command([1, 2, 3]), signal(), "local-window"),
      ).toEqual({
        status: "stopped",
        merged: [1],
        stoppedAt: 2,
        outcome: { status: "refused", reason: "checks-not-passing" },
      });
      expect(merge).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });
});
