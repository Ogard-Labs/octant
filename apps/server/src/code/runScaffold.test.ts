import type { CodeThread } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { CURATED_SCAFFOLDS } from "../scaffold/curatedScaffoldCatalog";
import {
  CodeOperationService,
  type CodeOperationScaffoldPort,
  type CodeOperationServiceOptions,
} from "./codeOperationService";

const ids = {
  thread: "70000000-0000-4000-8000-000000000010",
  checkout: "70000000-0000-4000-8000-000000000011",
  operation: "70000000-0000-4000-8000-000000000012",
  window: "70000000-0000-4000-8000-000000000013",
  project: "70000000-0000-4000-8000-000000000014",
  binding: "70000000-0000-4000-8000-000000000015",
  provider: "70000000-0000-4000-8000-000000000016",
  content: "70000000-0000-4000-8000-000000000017",
  scaffoldRun: "70000000-0000-4000-8000-000000000018",
  approval: "70000000-0000-4000-8000-000000000019",
};

const now = "2026-08-18T09:00:00.000Z";
const checkoutRoot = "/workspace/repository";

const thread = {
  id: ids.thread,
  projectId: ids.project,
  bindingRevisionId: ids.binding,
  repositoryId: `repo_${"a".repeat(64)}`,
  checkoutId: ids.checkout,
  title: "New project",
  lifecycle: "active",
  providerInstanceId: ids.provider,
  modelId: "model-a",
  executionPolicy: "full-access",
  permissionPersistence: "current-session",
  version: 1,
  createdAt: now,
  updatedAt: now,
} as unknown as CodeThread;

const checkout = {
  id: ids.checkout,
  repositoryId: thread.repositoryId,
  kind: "repository",
  availability: "available",
  head: { kind: "branch", name: "main", oid: "a".repeat(40) },
  observedAt: now,
} as never;

function harness(options: { readonly scaffolds?: unknown } = {}) {
  const run = vi.fn(async (_input: Parameters<CodeOperationScaffoldPort["run"]>[0]) => ({
    status: "ran" as const,
    run: {
      id: ids.scaffoldRun,
      scaffoldId: "web-app",
      threadId: ids.thread,
      checkoutId: ids.checkout,
      directoryName: "storefront",
      argv: ["bunx", "--bun", "create-vite@9.1.2", "storefront"],
      startedAt: now,
      completedAt: now,
      exitCode: 0,
      termination: "exited" as const,
      output: "Scaffolding project…",
      outputTruncated: false,
      outcome: "created" as const,
    },
  }));
  const scaffolds = {
    entry: (scaffoldId: string) =>
      CURATED_SCAFFOLDS.find((candidate) => String(candidate.id) === scaffoldId),
    run,
  };
  const service = new CodeOperationService({
    authority: {
      readThread: () => thread,
      readCheckout: () => checkout,
      canAccessProject: async () => true,
      resolveCheckoutRoot: async () => ({
        checkoutRoot,
        shell: "/bin/zsh",
        credentialReferences: [],
      }),
      approvalContextDigest: async () => "f".repeat(64),
    },
    approvals: { validate: async () => true },
    git: { observe: vi.fn() },
    evidence: {
      put: () => ({ contentId: ids.content, digest: "e".repeat(64), byteLength: 32 }),
      read: async () => undefined,
    },
    pullRequests: { ensure: vi.fn(), observe: vi.fn() },
    reviewFindings: { record: vi.fn() },
    terminals: { start: vi.fn(), write: vi.fn(), resize: vi.fn(), stop: vi.fn() },
    repositoryTests: { run: vi.fn(), cancel: vi.fn() },
    ...(options.scaffolds === null ? {} : { scaffolds: options.scaffolds ?? scaffolds }),
    turns: { start: vi.fn() },
    events: {
      append: vi.fn(),
      replay: vi.fn(() => ({ status: "ok" as const, frames: [], nextCursor: 0 })),
    },
    actor: { kind: "local-user", actorId: "70000000-0000-4000-8000-000000000021" },
    clock: () => now,
    uuid: () => ids.operation,
  } as unknown as CodeOperationServiceOptions);
  return { service, run };
}

function command(scaffoldId: string) {
  return {
    kind: "run-scaffold",
    operationId: ids.operation,
    threadId: ids.thread,
    checkoutId: ids.checkout,
    scaffoldRunId: ids.scaffoldRun,
    scaffoldId,
    directoryName: "storefront",
  } as const;
}

describe("starting a project from a curated scaffold", () => {
  it("runs the entry the host published, in the thread's own checkout", async () => {
    const { service, run } = harness();

    const result = await service.execute(ids.window as never, command("web-app"));

    expect(run.mock.calls[0]?.[0]).toMatchObject({
      runId: ids.scaffoldRun,
      directoryName: "storefront",
      checkoutRoot,
      executionPolicy: "full-access",
    });
    expect(result).toMatchObject({
      kind: "scaffold-run",
      run: { outcome: "created", directoryName: "storefront" },
    });
  });

  it("refuses a scaffold the host does not publish", async () => {
    const { service, run } = harness();

    const result = await service.execute(ids.window as never, command("web-app-two"));

    expect(result).toMatchObject({
      kind: "operation-failed",
      failure: { category: "unavailable" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses on a host that offers no scaffolds at all", async () => {
    const { service } = harness({ scaffolds: null });

    const result = await service.execute(ids.window as never, command("web-app"));

    expect(result).toMatchObject({
      kind: "operation-failed",
      failure: { category: "unavailable" },
    });
  });

  it("passes the runner's refusal back in the words the host used", async () => {
    const { service } = harness({
      scaffolds: {
        entry: (scaffoldId: string) =>
          CURATED_SCAFFOLDS.find((candidate) => String(candidate.id) === scaffoldId),
        run: async () => ({
          status: "refused" as const,
          message: "Something already exists at that name. Choose another.",
        }),
      },
    });

    const result = await service.execute(ids.window as never, command("web-app"));

    expect(result).toMatchObject({
      kind: "operation-failed",
      failure: {
        category: "invalid",
        message: "Something already exists at that name. Choose another.",
      },
    });
  });

  it.each(["../elsewhere", "nested/app", ".git", "-rf"])(
    "never reaches the runner with %s as a directory name",
    async (directoryName) => {
      const { service, run } = harness();

      // The command schema refuses the name outright, so the request never
      // becomes an operation the thread could approve.
      await expect(
        service.execute(ids.window as never, { ...command("web-app"), directoryName }),
      ).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    },
  );
});
