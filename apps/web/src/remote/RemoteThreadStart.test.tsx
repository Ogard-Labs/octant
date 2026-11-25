import type { CodeClient } from "@octant/client-runtime/code-client";
import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ProjectCommand } from "@octant/contracts/projects";
import {
  decodeFolderBrowseResult,
  decodeFolderSelectionResult,
} from "@octant/contracts/folder-browse";
import type { CodeCommand } from "@octant/contracts/code";
import { decodeProjectSummary } from "@octant/contracts/projects";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteCodeThreadStart } from "./RemoteThreadStart";

// Each group stands for one provider with one selectable model.
vi.mock("../providers/firstSelectableProviderSelection", () => ({
  firstSelectableProviderSelection: (groups: ReadonlyArray<{ instance: { id: string } }>) =>
    groups[0] === undefined
      ? undefined
      : { providerInstanceId: groups[0].instance.id, modelId: "gpt" },
}));

const allowedProvider = "80000000-0000-4000-8000-000000000005";
const refusedProvider = "80000000-0000-4000-8000-000000000006";
const providerGroups = [refusedProvider, allowedProvider].map((id) => ({
  instance: { id },
  sections: [{ models: [{ model: { id: "gpt" } }] }],
})) as unknown as Parameters<typeof RemoteCodeThreadStart>[0]["providerGroups"];

const settings = {
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "current-session",
  worktrees: { branchPrefix: "henrik/" },
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

let remoteFactReads = 0;
afterEach(() => {
  cleanup();
  remoteFactReads = 0;
});

async function startIn(
  summary: typeof project,
  groups: typeof providerGroups = providerGroups,
  host: {
    readonly answer?: (command: CodeCommand) => unknown;
    readonly refusal?: string;
    readonly startThreadTurn?: (input: { readonly checkoutId: unknown }) => Promise<boolean>;
    readonly checkout?: Record<string, unknown>;
  } = {},
): Promise<ReadonlyArray<CodeCommand>> {
  const sent: Array<CodeCommand> = [];
  const execute = vi.fn(async (command: CodeCommand) => {
    if (command.kind === "prepare-code-project-checkout") {
      return {
        kind: "checkout-prepared",
        bindingRevisionId: "80000000-0000-4000-8000-000000000002",
        checkout: {
          id: "80000000-0000-4000-8000-000000000003",
          repositoryId: `repo_${"a".repeat(64)}`,
          head: { kind: "branch", name: "main" },
          ...host.checkout,
        },
      };
    }
    if (command.kind === "get-worktree-remote-facts") {
      remoteFactReads += 1;
      return { kind: "worktree-remote-facts-retrieved", facts: { remotes: [] } };
    }
    sent.push(command);
    if (host.answer !== undefined) return host.answer(command);
    if (command.kind === "create-code-thread")
      return { kind: "thread-created", thread: command.thread };
    return undefined;
  });
  const controller = {
    bootstrap: { settings },
    execute,
    lastExecuteError: {
      current: host.refusal === undefined ? undefined : { message: host.refusal },
    },
    startThreadTurn: vi.fn(host.startThreadTurn ?? (async () => true)),
  } as unknown as Parameters<typeof RemoteCodeThreadStart>[0]["controller"];
  const projectClient = {
    bootstrap: async () => ({
      active: [summary],
      archived: [],
      availability: [
        { projectId: summary.id, status: "available", observedAt: "2026-11-12T10:00:00.000Z" },
      ],
      memory: [],
    }),
  } as unknown as ProjectClient;
  const user = userEvent.setup();
  render(
    <RemoteCodeThreadStart
      codeClient={
        { bootstrap: async () => ({ settings }) } as unknown as Pick<CodeClient, "bootstrap">
      }
      connected
      controller={controller}
      onCreated={() => undefined}
      projectClient={projectClient}
      providerGroups={groups}
    />,
  );
  await user.type(await screen.findByRole("textbox", { name: "First message" }), "Fix the bug");
  await user.click(screen.getByRole("button", { name: "Start thread" }));
  await waitFor(() => expect(sent).toHaveLength(1));
  return sent;
}

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
        providerGroups={providerGroups}
      />,
    );

    await user.type(await screen.findByRole("textbox", { name: "First message" }), "Fix the bug");
    await user.click(screen.getByRole("button", { name: "Start thread" }));

    await waitFor(() => expect(created).toHaveLength(1));
    const thread = created[0]?.kind === "create-code-thread" ? created[0].thread : undefined;
    expect(thread?.executionPolicy).toBe("approval-gated");
    expect(thread?.autoApprove).toBeUndefined();
  });

  it("binds the thread to the current checkout when that is the Project's default", async () => {
    const sent = await startIn(project);
    expect(sent[0]?.kind).toBe("create-code-thread");
  });

  it("starts in a plain folder the host admitted without Git, in that folder, without asking for a branch", async () => {
    const sent = await startIn(
      decodeProjectSummary({ ...project, newThreadWorkspace: "managed-worktree" }),
      providerGroups,
      { checkout: { kind: "plain-folder", availability: "available", head: { kind: "none" } } },
    );
    expect(sent[0]?.kind).toBe("create-code-thread");
    expect(remoteFactReads).toBe(0);
    expect(screen.queryByText(/Create or select a branch/)).toBeNull();
  });

  it("starts the thread in its own worktree when that is the Project's default", async () => {
    const sent = await startIn(
      decodeProjectSummary({ ...project, newThreadWorkspace: "managed-worktree" }),
    );
    expect(sent[0]?.kind).toBe("create-managed-code-thread");
    // The prefix the person chose in Settings, as on the host's own start screen.
    expect(JSON.stringify(sent[0])).toMatch(/"branchIntent":"henrik\/[a-z0-9-]+"/);
  });

  it("sends the first message to the new worktree's checkout once the host makes it", async () => {
    const worktreeCheckout = "80000000-0000-4000-8000-0000000000a1";
    const startThreadTurn = vi.fn(async (_input: { readonly checkoutId: unknown }) => true);
    await startIn(
      decodeProjectSummary({ ...project, newThreadWorkspace: "managed-worktree" }),
      providerGroups,
      {
        answer: (command) =>
          command.kind === "create-managed-code-thread"
            ? {
                kind: "managed-thread-created",
                thread: { id: command.threadId, checkoutId: worktreeCheckout },
              }
            : undefined,
        startThreadTurn,
      },
    );
    await waitFor(() => expect(startThreadTurn).toHaveBeenCalledTimes(1));
    expect(String(startThreadTurn.mock.calls[0]?.[0].checkoutId)).toBe(worktreeCheckout);
  });

  it("shows the host's reason and keeps the message when the host refuses the worktree", async () => {
    const refusal = "origin/feature/draft does not exist; start from the local branch at the host.";
    await startIn(
      decodeProjectSummary({ ...project, newThreadWorkspace: "managed-worktree" }),
      providerGroups,
      {
        answer: () => undefined,
        refusal,
      },
    );
    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue("Fix the bug");
  });

  it("starts on an EU or ZDR model tagged itself when its provider carries no tag", async () => {
    const untaggedProvider = "80000000-0000-4000-8000-000000000007";
    const groups = [
      {
        instance: { id: untaggedProvider },
        sections: [{ models: [{ model: { id: "zdr-model", dataTags: ["zdr"] } }] }],
      },
    ] as unknown as typeof providerGroups;
    const sent = await startIn(
      decodeProjectSummary({
        ...project,
        providerPolicy: { mode: "eu-zdr", providerInstanceIds: [] },
      }),
      groups,
    );
    const command = sent[0];
    const thread = command?.kind === "create-code-thread" ? command.thread : undefined;
    expect(String(thread?.providerInstanceId)).toBe(untaggedProvider);
  });

  it("picks the first model the Project's provider policy allows", async () => {
    const sent = await startIn(
      decodeProjectSummary({
        ...project,
        providerPolicy: { mode: "whitelist", providerInstanceIds: [allowedProvider] },
      }),
    );
    const command = sent[0];
    const thread = command?.kind === "create-code-thread" ? command.thread : undefined;
    expect(String(thread?.providerInstanceId)).toBe(allowedProvider);
  });

  it("makes a Code Project from a folder on that computer when it has none yet", async () => {
    const commands: Array<ProjectCommand> = [];
    const browse = vi.fn<FolderBrowseClient["browse"]>(async () =>
      decodeFolderBrowseResult({
        candidates: [
          {
            candidateId: "80000000-0000-4000-8000-0000000000c1",
            displayName: "notes",
            isGitRepository: true,
            isSelectable: true,
          },
        ],
        breadcrumbs: [],
        hasMore: false,
        browsedAt: "2026-11-20T09:00:00.000Z",
      }),
    );
    const select = vi.fn<FolderBrowseClient["select"]>(async () =>
      decodeFolderSelectionResult({
        receiptId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        displayName: "notes",
        selectedAt: "2026-11-20T09:00:01.000Z",
      }),
    );
    const projectClient = {
      bootstrap: async () => ({ active: [], archived: [], availability: [], memory: [] }),
      executeProject: vi.fn(async (command: ProjectCommand) => {
        commands.push(command);
        return { kind: "project-created", project: { ...project, id: command.projectId } };
      }),
    } as unknown as ProjectClient;
    const controller = {
      bootstrap: { settings },
      execute: vi.fn(async () => undefined),
      lastExecuteError: { current: undefined },
      startThreadTurn: vi.fn(async () => true),
    } as unknown as Parameters<typeof RemoteCodeThreadStart>[0]["controller"];
    const user = userEvent.setup();
    render(
      <RemoteCodeThreadStart
        codeClient={
          { bootstrap: async () => ({ settings }) } as unknown as Pick<CodeClient, "bootstrap">
        }
        connected
        controller={controller}
        folderBrowse={{ browse, select }}
        onCreated={() => undefined}
        projectClient={projectClient}
        providerGroups={[]}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "New Project from a folder on this computer" }),
    );
    await user.click(await screen.findByRole("button", { name: "Select" }));

    await waitFor(() => expect(commands).toHaveLength(1));
    // The folder is that computer's own, so the Project is that computer's local one.
    expect(commands[0]).toMatchObject({
      kind: "create-code-project",
      name: "notes",
      receiptId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      hostId: "local",
    });
    expect(browse).toHaveBeenCalledWith(expect.objectContaining({ hostId: "local", mode: "code" }));
  });

  it("shows Clone from this computer only when the window acts as that computer's own person", async () => {
    const projectClient = {
      bootstrap: async () => ({
        active: [],
        archived: [],
        availability: [],
        memory: [],
      }),
      execute: vi.fn(),
    } as unknown as ProjectClient;
    const controller = {
      bootstrap: { settings },
      execute: vi.fn(async () => undefined),
      lastExecuteError: { current: undefined },
      startThreadTurn: vi.fn(async () => true),
    } as unknown as Parameters<typeof RemoteCodeThreadStart>[0]["controller"];
    const onCloneFromThisComputer = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <RemoteCodeThreadStart
        actsAsHostPerson={false}
        codeClient={
          { bootstrap: async () => ({ settings }) } as unknown as Pick<CodeClient, "bootstrap">
        }
        connected
        controller={controller}
        onCloneFromThisComputer={onCloneFromThisComputer}
        onCreated={() => undefined}
        projectClient={projectClient}
        providerGroups={[]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Clone a repository from this computer" }),
    ).toBeNull();

    rerender(
      <RemoteCodeThreadStart
        actsAsHostPerson
        codeClient={
          { bootstrap: async () => ({ settings }) } as unknown as Pick<CodeClient, "bootstrap">
        }
        connected
        controller={controller}
        onCloneFromThisComputer={onCloneFromThisComputer}
        onCreated={() => undefined}
        projectClient={projectClient}
        providerGroups={[]}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Clone a repository from this computer" }),
    );
    expect(onCloneFromThisComputer).toHaveBeenCalledTimes(1);
  });
});
