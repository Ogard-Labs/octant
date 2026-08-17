import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeOperationResult } from "@octant/contracts/code-operations";
import type { CodeRepositoryTestDefinition } from "@octant/contracts/code-test-definitions";
import { vi } from "vitest";

export const ids = {
  approval: "10000000-0000-4000-8000-000000000001",
  checkout: "20000000-0000-4000-8000-000000000001",
  content: "30000000-0000-4000-8000-000000000001",
  file: "40000000-0000-4000-8000-000000000001",
  finding: "50000000-0000-4000-8000-000000000001",
  git: "60000000-0000-4000-8000-000000000001",
  operation: "70000000-0000-4000-8000-000000000001",
  terminal: "80000000-0000-4000-8000-000000000001",
  testDefinition: "90000000-0000-4000-8000-000000000001",
  testRun: "a0000000-0000-4000-8000-000000000001",
  thread: "b0000000-0000-4000-8000-000000000001",
} as const;

export function codeClient(options: { readonly evidence?: string } = {}): CodeClient {
  return {
    bootstrap: vi.fn(),
    queryBoard: vi.fn(),
    conversation: vi.fn(async (threadId) => ({
      version: 2 as const,
      threadId,
      turns: [],
      nextCursor: 0,
      hasMore: false,
    })),
    content: vi.fn(async () => new TextEncoder().encode("const answer = 42;\n")),
    execute: vi.fn(),
    executeOperation: vi.fn<CodeClient["executeOperation"]>(
      async (command) =>
        ({ kind: "operation-accepted", operationId: command.operationId }) as never,
    ),
    inspectTerminal: vi.fn(async (input) => ({
      terminalId: input.terminalId,
      state: "running" as const,
    })),
    operationContent: vi.fn(async () =>
      new TextEncoder().encode(options.evidence ?? "authoritative evidence"),
    ),
    putAttachment: vi.fn(),
    discardAttachment: vi.fn(),
    attachment: vi.fn(),
    putEvidence: vi.fn(async () => ({
      contentId: ids.content as never,
      digest: "a".repeat(64),
      byteLength: 4,
    })),
    listTests: vi.fn(async (threadId, checkoutId) => ({
      kind: "code-repository-test-listing" as const,
      threadId,
      checkoutId,
      definitions: [testDefinition],
      observedAt: "2026-08-15T08:00:00.000Z" as never,
    })),
    openFile: vi.fn(async () => ({
      status: "editable" as const,
      fileId: ids.file as never,
      metadata: {
        identity: { device: "1", inode: "2" },
        byteLength: 19,
        modifiedNanoseconds: "3",
        digest: "d".repeat(64),
      } as never,
      content: evidence(false) as never,
    })),
    save: vi.fn(),
    subscribe: vi.fn(),
    subscribeOperation: vi.fn(),
    thread: vi.fn(),
    readFollowUp: vi.fn(async (threadId) => ({ threadId, followUpVersion: 0 }) as never),
    executeFollowUp: vi.fn(),
  };
}

export const scope = {
  checkoutId: ids.checkout as never,
  threadId: ids.thread as never,
} as const;

export const terminalResult = {
  kind: "terminal-state",
  operationId: ids.operation,
  terminalId: ids.terminal,
  state: "running",
  transcript: evidence(false),
} as unknown as Extract<CodeOperationResult, { readonly kind: "terminal-state" }>;

export const gitObservation = {
  kind: "git-observed",
  operationId: ids.operation,
  gitOperationId: ids.git,
  head: { kind: "branch", name: "feature/delivery", oid: "a".repeat(40) },
  stateToken: "b".repeat(64),
  status: [
    { path: "src/changed.ts", index: " ", worktree: "M" },
    { path: "src/staged.ts", index: "M", worktree: " " },
  ],
  changedPaths: ["src/changed.ts", "src/staged.ts"],
  diff: evidence(false),
  remotes: [
    {
      name: "origin",
      fetch: { kind: "network", url: "https://github.com/octant/octant.git" },
      push: { kind: "network", url: "https://github.com/octant/octant.git" },
    },
  ],
  upstream: { remote: "origin", mergeRef: "refs/heads/feature/delivery" },
  worktrees: [],
} as unknown as Extract<CodeOperationResult, { readonly kind: "git-observed" }>;

export const unbornGitObservation = {
  ...gitObservation,
  head: { kind: "unborn", name: "main" },
  upstream: null,
} as unknown as Extract<CodeOperationResult, { readonly kind: "git-observed" }>;

export const pullRequestReviewNone = {
  kind: "pull-request-review",
  operationId: ids.operation,
  state: "none",
  freshness: "fresh",
} as unknown as Extract<CodeOperationResult, { readonly kind: "pull-request-review" }>;

export const testDefinition = {
  id: ids.testDefinition,
  name: "Web tests",
  source: {
    kind: "package-script",
    packagePath: "apps/web",
    packageManager: "bun",
    script: "test",
  },
  argv: ["bun", "run", "test"],
  cwd: "apps/web",
  environmentRefs: [],
  timeoutMs: 60_000,
  artifactPaths: ["coverage/index.html"],
} as unknown as CodeRepositoryTestDefinition;

export function evidence(truncated: boolean) {
  return {
    contentId: ids.content,
    digest: "c".repeat(64),
    byteLength: 128,
    ...(truncated ? { truncated: true } : {}),
  } as const;
}
