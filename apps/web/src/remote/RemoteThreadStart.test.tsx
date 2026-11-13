import type { CodeClient } from "@octant/client-runtime/code-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { CodeCommand } from "@octant/contracts/code";
import { decodeProjectSummary } from "@octant/contracts/projects";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteCodeThreadStart } from "./RemoteThreadStart";

vi.mock("../providers/firstSelectableProviderSelection", () => ({
  firstSelectableProviderSelection: () => ({
    providerInstanceId: "80000000-0000-4000-8000-000000000005",
    modelId: "gpt",
  }),
}));

const settings = {
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "current-session",
  version: 5,
  updatedAt: "2026-11-12T10:00:00.000Z",
} as const;

const project = decodeProjectSummary({
  id: "80000000-0000-4000-8000-000000000001",
  type: "code",
  name: "Notes",
  lifecycle: "active",
  pinned: false,
  rank: "0/1",
  version: 3,
  createdAt: "2026-10-27T10:00:00.000Z",
  updatedAt: "2026-10-27T10:00:00.000Z",
  binding: { canonicalRoot: "/repositories/notes" },
  bindingRevisionId: "80000000-0000-4000-8000-000000000002",
  codeAccessPersistence: "current-session",
});

afterEach(cleanup);

describe("starting a Code thread from a browser the host's own person paired", () => {
  it("starts at the host's current default, not the one this view read earlier", async () => {
    const created: Array<CodeCommand> = [];
    const execute = vi.fn(async (command: CodeCommand) => {
      if (command.kind === "prepare-code-project-checkout") {
        return {
          kind: "checkout-prepared",
          bindingRevisionId: "80000000-0000-4000-8000-000000000002",
          checkout: {
            id: "80000000-0000-4000-8000-000000000003",
            repositoryId: `repo_${"a".repeat(64)}`,
            head: { kind: "branch", name: "main" },
          },
        };
      }
      if (command.kind === "get-worktree-remote-facts") {
        return { kind: "worktree-remote-facts-retrieved", facts: { remotes: [] } };
      }
      if (command.kind === "create-code-thread") {
        created.push(command);
        return { kind: "thread-created", thread: command.thread };
      }
      return undefined;
    });
    const controller = {
      // Read before the default was lowered from Full access to Ask first.
      bootstrap: { settings: { ...settings, defaultExecutionPolicy: "full-access", version: 4 } },
      execute,
      lastExecuteError: { current: undefined },
      startThreadTurn: vi.fn(async () => true),
    } as unknown as Parameters<typeof RemoteCodeThreadStart>[0]["controller"];
    const codeClient = {
      bootstrap: async () => ({ settings }),
    } as unknown as Pick<CodeClient, "bootstrap">;
    const projectClient = {
      bootstrap: async () => ({
        active: [project],
        archived: [],
        availability: [
          { projectId: project.id, status: "available", observedAt: "2026-11-12T10:00:00.000Z" },
        ],
        memory: [],
      }),
    } as unknown as ProjectClient;
    const user = userEvent.setup();
    render(
      <RemoteCodeThreadStart
        codeClient={codeClient}
        connected
        controller={controller}
        onCreated={() => undefined}
        projectClient={projectClient}
        providerGroups={[]}
      />,
    );

    await user.type(await screen.findByRole("textbox", { name: "First message" }), "Fix the bug");
    await user.click(screen.getByRole("button", { name: "Start thread" }));

    await waitFor(() => expect(created).toHaveLength(1));
    const thread = created[0]?.kind === "create-code-thread" ? created[0].thread : undefined;
    expect(thread?.executionPolicy).toBe("approval-gated");
    expect(thread?.autoApprove).toBeUndefined();
  });
});
