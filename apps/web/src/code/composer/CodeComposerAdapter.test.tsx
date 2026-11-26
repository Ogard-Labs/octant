import { nativeFolderTransfer } from "../../composer/folderDrop.test-fixture";
import { decodeProviderInstance, decodeProviderModelId } from "@octant/contracts";
import { decodeExtensionSelection } from "@octant/contracts/extensions";
import type { PickerGroup } from "@octant/domain";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act, useState } from "react";
import type { NewTaskCreateFromSelection } from "../../composer/useNewTaskPrompt";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeComposerAdapter, type CodeComposerSubmitInput } from "./CodeComposerAdapter";
import { BookOpen } from "../../ui/icons";
import type { ProjectId } from "@octant/contracts/projects";
import { decodeHostId, LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  createNewTaskDrafts,
  NewTaskDraftsContext,
  NewTaskDraftScopeContext,
} from "../../composer/useNewTaskPrompt";

const whereChip = () => screen.getByRole("button", { name: /^Where this thread works/ });

const twoHosts = [
  {
    hostId: LOCAL_HOST_ID,
    displayName: "This computer",
    health: "healthy" as const,
    capabilities: ["chat", "work", "code"],
  },
  {
    hostId: decodeHostId("11111111-1111-4111-8111-111111111111"),
    displayName: "Studio",
    health: "healthy" as const,
    capabilities: ["chat", "work", "code"],
  },
];

type DraftAnchor = {
  readonly kind: "draft";
  readonly projectId: string;
  readonly composerId: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
};

const defaultProps = {
  projectId: "00000000-0000-0000-0000-000000000001" as ProjectId,
  projectName: "My Repo",
  projectRoot: "/home/user/repo",
  baseBranch: "development",
  defaultPermissionMode: "ask-first" as const,
  defaultPermissionPersistence: "current-session" as const,
  providerGroups: [],
  onSelectProvider: () => {},
  onCreateThread: () => {},
  onCancel: () => {},
};

function twoModelGroup(): PickerGroup {
  const instance = decodeProviderInstance({
    id: "80000000-0000-4000-8000-0000000000b1",
    displayName: "Local Codex",
    driverKind: "codex",
    configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:00.000Z",
  });
  const entry = (id: string, displayName: string) => ({
    model: {
      id: decodeProviderModelId(id),
      displayName,
      reasoning: "unsupported" as const,
      inputModalities: ["text" as const],
      source: "discovered" as const,
      verification: "verified" as const,
      options: [],
    },
    badges: [],
    toolCapable: true,
  });
  return {
    instance,
    runtime: "provider",
    readiness: "ready",
    driverLabel: "Codex",
    endpointHost: undefined,
    executionHost: "Local host",
    sections: [
      {
        id: "all-models",
        label: "Models",
        models: [entry("model-one", "Model One"), entry("model-two", "Model Two")],
      },
    ],
  };
}

describe("CodeComposerAdapter", () => {
  it("attaches a 40 KiB paste on the Code start screen as a text file", async () => {
    render(<CodeComposerAdapter {...defaultProps} />);
    const prompt = screen.getByRole("textbox", { name: "First message" });
    prompt.focus();
    fireEvent.paste(prompt, {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "x".repeat(40 * 1024) : ""),
        files: [],
        items: [],
        types: ["text/plain"],
      },
    });
    // A start needs words, so the prompt points at the file instead of staying empty.
    expect(prompt).toHaveValue("See the attached pasted-text-1.txt.");
    expect(await screen.findByText("pasted-text-1.txt")).toBeInTheDocument();
  });

  it("⌘↩ on a start composer creates the thread and leaves a fresh draft", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn((input: CodeComposerSubmitInput) => {
      input.stay?.report({ status: "started", threadId: "thread-1" });
      return true;
    });
    render(
      <CodeComposerAdapter {...defaultProps} onCreateThread={onCreateThread} startsInBackground />,
    );
    await user.click(whereChip());
    await user.click(screen.getByRole("radio", { name: /New worktree/ }));
    await user.keyboard("{Escape}");
    const prompt = screen.getByRole("textbox", { name: "First message" });
    await user.type(prompt, "Fix the login bug");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
    const first = onCreateThread.mock.calls[0]?.[0];
    expect(first).toMatchObject({ prompt: "Fix the login bug", stay: expect.anything() });
    expect(first).not.toHaveProperty("presentation");
    expect(prompt).toHaveValue("");
    expect(await screen.findByText(/started\./)).toBeInTheDocument();

    // The fresh draft keeps its Project, workspace and base branch, and a
    // second start right away gets a branch of its own.
    expect(whereChip()).toHaveTextContent("New worktree");
    expect(screen.getAllByText("My Repo").length).toBeGreaterThan(0);
    await user.type(prompt, "Fix the logout bug");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(2));
    const second = onCreateThread.mock.calls[1]?.[0];
    expect(second).toMatchObject({
      workspace: "managed-worktree",
      deliveryTarget: { proposedBaseBranch: "development" },
    });
    expect(first?.deliveryTarget.proposedBaseBranch).toBe("development");
    expect(second?.deliveryTarget.branchIntent).not.toBe(first?.deliveryTarget.branchIntent);
    // Both starts are listed, not just the last.
    expect(await screen.findAllByText(/started\./)).toHaveLength(2);
  });

  it("⌘↩ sends a staged plugin choice with that start only, and leaves the next draft without it", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn((_input: CodeComposerSubmitInput) => true);
    const drafts = createNewTaskDrafts();
    drafts.writeExtensionReceipts("code:pane", [
      {
        reference: "@review",
        label: "Review",
        selection: decodeExtensionSelection({
          kind: "plugin",
          extensionId: "00000000-0000-4000-8000-000000000301",
          packageId: "00000000-0000-4000-8000-000000000302",
          componentId: "review",
          packageVersion: "1.0.0",
          packageDigest: `sha256:${"a".repeat(64)}`,
          catalogEpoch: `sha256:${"b".repeat(64)}`,
          origin: { kind: "draft", reference: "00000000-0000-4000-8000-000000000201" },
        }),
        status: { kind: "selected" },
      },
    ]);
    render(
      <NewTaskDraftsContext.Provider value={drafts}>
        <NewTaskDraftScopeContext.Provider value="code:pane">
          <CodeComposerAdapter
            {...defaultProps}
            onCreateThread={onCreateThread}
            startsInBackground
          />
        </NewTaskDraftScopeContext.Provider>
      </NewTaskDraftsContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "Remove Review extension" })).toBeVisible();
    const prompt = screen.getByRole("textbox", { name: "First message" });
    await user.type(prompt, "Review the parser");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
    expect(onCreateThread.mock.calls[0]?.[0].extensionSelections).toHaveLength(1);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove Review extension" })).toBeNull(),
    );
    await user.type(prompt, "Fix the logout bug");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(2));
    expect(onCreateThread.mock.calls[1]?.[0]).not.toHaveProperty("extensionSelections");
  });

  it("⌘↩ starts every model's thread from the chosen issue, and the next draft starts from none", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn((_input: CodeComposerSubmitInput) => true);
    const group = twoModelGroup();
    const issue = {
      kind: "github" as const,
      request: { owner: "octo", name: "repo", number: 7 },
      label: "octo/repo#7",
    };
    function Harness() {
      const [source, setSource] = useState<NewTaskCreateFromSelection | undefined>(issue);
      return (
        <>
          <output aria-label="Create from">{source?.label ?? "none"}</output>
          <CodeComposerAdapter
            {...defaultProps}
            providerGroups={[group]}
            selectedProviderInstanceId={group.instance.id}
            selectedModelId={decodeProviderModelId("model-one")}
            onCreateThread={onCreateThread}
            stashSource={{ current: source, change: setSource }}
            startsInBackground
          />
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("option", { name: "Model Two" }));
    await user.keyboard("{/Shift}{Escape}");
    const prompt = screen.getByRole("textbox", { name: "First message" });
    await user.type(prompt, "Fix issue 7");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(2));
    for (const [input] of onCreateThread.mock.calls) {
      expect(input.issueContext).toEqual(issue.request);
    }
    expect(screen.getByRole("status", { name: "Create from" })).toHaveTextContent("none");

    await user.click(screen.getByRole("button", { name: "Use one model" }));
    await user.type(prompt, "Unrelated task");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(3));
    expect(onCreateThread.mock.calls[2]?.[0]).not.toHaveProperty("issueContext");
  });

  it("gives the issue back when a start that stays created nothing, unless the next draft began", async () => {
    const user = userEvent.setup();
    let refuse: () => void = () => undefined;
    const onCreateThread = vi.fn(
      (input: CodeComposerSubmitInput) =>
        new Promise<boolean>((resolve) => {
          refuse = () => {
            input.stay?.report({ status: "refused", reason: "The provider is not signed in." });
            resolve(false);
          };
        }),
    );
    const issue = {
      kind: "github" as const,
      request: { owner: "octo", name: "repo", number: 7 },
      label: "octo/repo#7",
    };
    function Harness() {
      const [source, setSource] = useState<NewTaskCreateFromSelection | undefined>(issue);
      return (
        <>
          <output aria-label="Create from">{source?.label ?? "none"}</output>
          <CodeComposerAdapter
            {...defaultProps}
            onCreateThread={onCreateThread}
            stashSource={{ current: source, change: setSource }}
            startsInBackground
          />
        </>
      );
    }
    render(<Harness />);
    const prompt = screen.getByRole("textbox", { name: "First message" });
    await user.type(prompt, "Fix issue 7");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
    const createFrom = screen.getByRole("status", { name: "Create from" });
    expect(createFrom).toHaveTextContent("none");
    await act(async () => refuse());
    await waitFor(() => expect(createFrom).toHaveTextContent("octo/repo#7"));
    expect(prompt).toHaveValue("Fix issue 7");

    // A refusal that lands once the next draft is under way leaves that draft alone.
    await user.clear(prompt);
    await user.type(prompt, "Again");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(2));
    await user.type(prompt, "Next task");
    await act(async () => refuse());
    await screen.findAllByText(/The provider is not signed in\./);
    expect(createFrom).toHaveTextContent("none");
    expect(prompt).toHaveValue("Next task");
  });

  it("offers neither ⌘↩ start-and-stay nor several models where the create path cannot carry them", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn((_input: CodeComposerSubmitInput) => true);
    const group = twoModelGroup();
    render(
      <CodeComposerAdapter
        {...defaultProps}
        providerGroups={[group]}
        selectedProviderInstanceId={group.instance.id}
        selectedModelId={decodeProviderModelId("model-one")}
        onCreateThread={onCreateThread}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("option", { name: "Model Two" }));
    await user.keyboard("{/Shift}{Escape}");
    expect(screen.queryByText(/Starts 2 threads/)).toBeNull();

    await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix it");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
    expect(onCreateThread.mock.calls[0]?.[0]).not.toHaveProperty("stay");
  });

  it("adds a model beside the chosen one from the keyboard with Shift+Enter", async () => {
    const user = userEvent.setup();
    const onSelectProvider = vi.fn();
    const group = twoModelGroup();
    render(
      <CodeComposerAdapter
        {...defaultProps}
        providerGroups={[group]}
        selectedProviderInstanceId={group.instance.id}
        selectedModelId={decodeProviderModelId("model-one")}
        onSelectProvider={onSelectProvider}
        startsInBackground
      />,
    );
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    expect(screen.getByRole("listbox", { name: "Models" })).toHaveAttribute(
      "aria-multiselectable",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("option", { name: "Model Two" }), {
      key: "Enter",
      shiftKey: true,
    });
    await user.keyboard("{Escape}");
    expect(await screen.findByText(/Starts 2 threads/)).toBeInTheDocument();
    expect(onSelectProvider).not.toHaveBeenCalled();
  });

  it("brings the prompt and its files back when no start created anything", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn((input: CodeComposerSubmitInput) => {
      input.stay?.report({ status: "refused", reason: "The provider is not signed in." });
      return false;
    });
    render(
      <CodeComposerAdapter {...defaultProps} onCreateThread={onCreateThread} startsInBackground />,
    );
    const prompt = screen.getByRole("textbox", { name: "First message" });
    prompt.focus();
    fireEvent.paste(prompt, {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "z".repeat(40 * 1024) : ""),
        files: [],
        items: [],
        types: ["text/plain"],
      },
    });
    await screen.findByText("pasted-text-1.txt");
    await user.clear(prompt);
    await user.type(prompt, "Fix the login bug");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(await screen.findByText(/The provider is not signed in\./)).toBeInTheDocument();
    await waitFor(() => expect(prompt).toHaveValue("Fix the login bug"));
    expect(screen.getByText("pasted-text-1.txt")).toBeInTheDocument();
  });

  it("two selected models start two threads in two new worktrees", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn((_input: CodeComposerSubmitInput) => true);
    const group = twoModelGroup();
    render(
      <CodeComposerAdapter
        {...defaultProps}
        providerGroups={[group]}
        selectedProviderInstanceId={group.instance.id}
        selectedModelId={decodeProviderModelId("model-one")}
        onCreateThread={onCreateThread}
        startsInBackground
      />,
    );
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("option", { name: "Model Two" }));
    await user.keyboard("{/Shift}{Escape}");
    expect(screen.getByText(/Starts 2 threads, each in a new worktree/)).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: "Start 2 threads" }));

    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(2));
    const [first, second] = onCreateThread.mock.calls.map(([input]) => input);
    expect(first).toMatchObject({
      workspace: "managed-worktree",
      providerSelection: { modelId: "model-one" },
    });
    expect(second).toMatchObject({
      workspace: "managed-worktree",
      providerSelection: { modelId: "model-two" },
    });
    expect(second?.deliveryTarget.branchIntent).toBe(
      `${String(first?.deliveryTarget.branchIntent)}-model-two`,
    );
    // Options chosen for the first model are not guessed onto the second.
    expect(second).not.toHaveProperty("modelOptionValues");
  });

  it("keeps a reviewed proposal exact and names the create-and-start decision", async () => {
    const onCreateThread = vi.fn();
    render(
      <CodeComposerAdapter
        {...defaultProps}
        fixedPrompt="Fix only the described parser issue."
        createLabel="Approve and start described task"
        onCreateThread={onCreateThread}
      />,
    );
    const prompt = screen.getByRole("textbox", { name: "First message" });
    expect(prompt).toHaveAttribute("readonly");
    await userEvent.type(prompt, " and something else");
    expect(prompt).toHaveValue("Fix only the described parser issue.");
    await userEvent.click(screen.getByRole("button", { name: "Approve and start described task" }));
    await waitFor(() =>
      expect(onCreateThread).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Fix only the described parser issue." }),
      ),
    );
  });

  it("keeps provider controls available while an unavailable provider prevents approval", () => {
    render(
      <CodeComposerAdapter
        {...defaultProps}
        fixedPrompt="Reviewed task"
        createLabel="Approve and start described task"
        createDisabledReason="Choose an available provider and model before approving this task."
      />,
    );
    expect(screen.getByRole("button", { name: "Approve and start described task" })).toBeDisabled();
    expect(
      screen.getByText("Choose an available provider and model before approving this task."),
    ).toBeVisible();
  });

  it("submits the chosen reasoning level with a new Code thread", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-0000000000a1",
      displayName: "Local Codex",
      driverKind: "codex",
      configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-09-15T10:00:00.000Z",
      updatedAt: "2026-09-15T10:00:00.000Z",
    });
    const modelId = decodeProviderModelId("model-one");
    const group: PickerGroup = {
      instance,
      runtime: "provider",
      readiness: "ready",
      driverLabel: "Codex",
      endpointHost: undefined,
      executionHost: "Local host",
      sections: [
        {
          id: "all-models",
          label: "Models",
          models: [
            {
              model: {
                id: modelId,
                displayName: "Model One",
                reasoning: "supported",
                inputModalities: ["text"],
                source: "discovered",
                verification: "verified",
                options: [
                  {
                    id: "effort",
                    displayName: "Effort",
                    kind: "selection",
                    values: ["low", "high"],
                  },
                ],
              },
              badges: [],
              toolCapable: true,
            },
          ],
        },
      ],
    };
    render(
      <CodeComposerAdapter
        {...defaultProps}
        providerGroups={[group]}
        selectedProviderInstanceId={instance.id}
        selectedModelId={modelId}
        onCreateThread={onCreateThread}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const effort = screen.getByRole("group", { name: "Effort level" });
    await user.click(within(effort).getByRole("button", { name: "High" }));
    expect(within(effort).getByRole("button", { name: "High" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.keyboard("{Escape}");
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix search");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() =>
      expect(onCreateThread).toHaveBeenCalledWith(
        expect.objectContaining({ modelOptionValues: { effort: "high" } }),
      ),
    );
  });

  it("offers prompt suggestions as cards that say what they do and fill the prompt only when chosen", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    render(
      <CodeComposerAdapter
        {...defaultProps}
        onCreateThread={onCreateThread}
        suggestions={[
          {
            id: "explain",
            label: "Explain this codebase",
            detail: "Entry points and how to run it.",
            icon: BookOpen,
            prompt: "Explain the entry points and data flow.",
          },
        ]}
      />,
    );
    expect(screen.queryByRole("button", { name: /example details/i })).toBeNull();
    const chip = screen.getByRole("button", { name: "Explain this codebase" });
    expect(chip).toHaveTextContent("Entry points and how to run it.");
    expect(chip).toHaveAccessibleDescription("Explain the entry points and data flow.");
    expect(chip).toHaveAttribute("title", "Explain the entry points and data flow.");
    await user.click(screen.getByRole("button", { name: "Explain this codebase" }));
    expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue(
      "Explain the entry points and data flow.",
    );
    expect(screen.getByRole("textbox", { name: "First message" })).toHaveFocus();
    expect(onCreateThread).not.toHaveBeenCalled();
    // With words in the box the cards are out of reach but still in the
    // page, so nothing under them moves.
    expect(screen.queryByRole("button", { name: "Explain this codebase" })).toBeNull();
    const group = document.querySelector<HTMLElement>(".code-home__suggestions");
    expect(group).toHaveAttribute("data-away", "true");
    expect(group).toHaveAttribute("aria-hidden", "true");
    expect(group?.querySelector("button")).toBeDisabled();
  });

  it("renders composer with project and branch context", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    expect(html).toContain("What should we work on in ");
    expect(html).not.toContain("What should we build");
    expect(html).toContain("My Repo");
    expect(html).toContain("development");
  });

  it("keeps a draft and its native anchor identity when the Project changes", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    const updateCodeOperationApprovalAnchor = vi.fn(
      async (_value: DraftAnchor): Promise<void> => undefined,
    );
    const cancelCodeOperationApproval = vi.fn(async () => undefined);
    const hostBridge = { updateCodeOperationApprovalAnchor, cancelCodeOperationApproval };
    const firstProject = defaultProps.projectId;
    const secondProject = "00000000-0000-0000-0000-000000000002" as ProjectId;
    const { rerender } = render(
      <div className="thread-composer">
        <CodeComposerAdapter
          {...defaultProps}
          hostBridge={hostBridge as never}
          onCreateThread={onCreateThread}
        />
      </div>,
    );
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Keep this draft");
    rerender(
      <div className="thread-composer">
        <CodeComposerAdapter
          {...defaultProps}
          projectId={secondProject}
          hostBridge={hostBridge as never}
          onCreateThread={onCreateThread}
        />
      </div>,
    );

    expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue("Keep this draft");
    await waitFor(() => expect(updateCodeOperationApprovalAnchor).toHaveBeenCalledTimes(2));
    const anchors = updateCodeOperationApprovalAnchor.mock.calls.map(([value]) => value);
    expect(anchors[0]).toMatchObject({ kind: "draft", projectId: String(firstProject) });
    expect(anchors[1]).toMatchObject({ kind: "draft", projectId: String(secondProject) });
    expect(anchors[0]?.composerId).toBe(anchors[1]?.composerId);

    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
    expect(onCreateThread.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Keep this draft",
      presentation: { composerId: anchors[1]?.composerId },
    });
  });

  it("gives multiple draft panes distinct native anchor identities", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const updateCodeOperationApprovalAnchor = vi.fn(
      async (_value: DraftAnchor): Promise<void> => undefined,
    );
    const hostBridge = { updateCodeOperationApprovalAnchor };
    render(
      <>
        <div className="thread-composer">
          <CodeComposerAdapter {...defaultProps} hostBridge={hostBridge as never} />
        </div>
        <div className="thread-composer">
          <CodeComposerAdapter {...defaultProps} hostBridge={hostBridge as never} />
        </div>
      </>,
    );

    await waitFor(() => expect(updateCodeOperationApprovalAnchor).toHaveBeenCalledTimes(2));
    const composerIds = updateCodeOperationApprovalAnchor.mock.calls.map(
      ([value]) => value.composerId,
    );
    expect(new Set(composerIds).size).toBe(2);
  });

  it("shows a caller's decision heading in place of the start screen's question", () => {
    const { rerender } = render(<CodeComposerAdapter {...defaultProps} />);
    expect(
      screen.getByRole("heading", { name: "What should we work on in My Repo?" }),
    ).toBeVisible();
    rerender(<CodeComposerAdapter {...defaultProps} heading={<h2>Review the proposal</h2>} />);
    expect(screen.getByRole("heading", { name: "Review the proposal" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "What should we work on in My Repo?" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/just start typing/)).not.toBeInTheDocument();
  });

  it("asks in the same plain words as every start screen rather than opening on a tip", () => {
    render(<CodeComposerAdapter {...defaultProps} />);
    expect(screen.getByRole("textbox", { name: "First message" })).toHaveAttribute(
      "placeholder",
      "Ask anything…",
    );
  });

  it("puts Project, branch, and Environment on the context row above the composer card", () => {
    const { container } = render(<CodeComposerAdapter {...defaultProps} hosts={twoHosts} />);
    const frame = container.querySelector(".composer");
    const dock = container.querySelector(".composer-tray");
    const row = container.querySelector(".composer-row");
    expect(
      screen.getByRole("heading", { name: "What should we work on in My Repo?" }),
    ).toBeVisible();
    expect(frame).not.toBeNull();
    expect(dock).not.toBeNull();
    if (frame === null || dock === null || row === null) {
      throw new Error("Composer stack is incomplete.");
    }
    // The card holds the prompt; where the thread runs is a row of the
    // composer's tray above it.
    expect(frame.contains(dock)).toBe(true);
    expect(container.querySelector(".thread-composer__surface")?.contains(dock)).toBe(false);
    expect(
      dock.compareDocumentPosition(screen.getByRole("textbox", { name: "First message" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(row.querySelector(".host-selector")).toBeNull();
    expect(dock?.textContent).toContain("My Repo");
    expect(dock?.querySelector(".host-selector")).not.toBeNull();
    expect(dock?.querySelector(".host-selector--environment")).not.toBeNull();
    expect(dock?.textContent).toContain("development");
    const text = dock?.textContent ?? "";
    expect(text.indexOf("My Repo")).toBeLessThan(text.indexOf("development"));
    expect(text.indexOf("development")).toBeLessThan(text.indexOf("This computer"));
  });

  it("derives the delivery target from the tray instead of asking for it again", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    render(
      <CodeComposerAdapter
        {...defaultProps}
        baseRepository="acme/octant"
        onCreateThread={onCreateThread}
      />,
    );

    expect(screen.queryByRole("button", { name: "Delivery target" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
    expect(onCreateThread.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Fix the login bug",
      deliveryTarget: {
        proposedBaseRepository: "acme/octant",
        proposedBaseBranch: "development",
        remoteName: "origin",
        outcomeKind: expect.any(String),
      },
    });
    expect(onCreateThread.mock.calls[0]?.[0].deliveryTarget.branchIntent).not.toBe("development");
    expect(onCreateThread.mock.calls[0]?.[0]).not.toHaveProperty("baseBranchAssumed");
  });

  it("starts the thread in Auto where the provider has a reviewer, and shows Auto disabled with the reason where it has none", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    const rendered = render(
      <CodeComposerAdapter
        {...defaultProps}
        autoSupported
        defaultPermissionMode="auto"
        onCreateThread={onCreateThread}
      />,
    );
    expect(screen.getByRole("button", { name: /^Mode:/ })).toHaveAccessibleName("Mode: Auto");
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Ship it");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
    expect(onCreateThread.mock.calls[0]?.[0]).toMatchObject({
      executionPolicy: "approval-gated",
      autoApprove: true,
    });
    rendered.unmount();

    render(<CodeComposerAdapter {...defaultProps} defaultPermissionMode="auto" />);
    expect(screen.getByRole("button", { name: /^Mode:/ })).toHaveAccessibleName("Mode: Ask first");
    await user.click(screen.getByRole("button", { name: /^Mode:/ }));
    expect(await screen.findByRole("menuitemradio", { name: "Auto" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("shows Set up a provider on the Code start composer until a provider is ready", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <CodeComposerAdapter {...defaultProps} providerGroups={[]} onOpenSettings={onOpenSettings} />,
    );
    const setup = screen.getByRole("button", { name: "Set up a provider" });
    expect(setup).toBeEnabled();
    await user.click(setup);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("keeps Set up a provider locked while the Code start composer is creating", () => {
    render(
      <CodeComposerAdapter
        {...defaultProps}
        creating
        providerGroups={[]}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Set up a provider" })).toBeDisabled();
  });

  it("puts the Project picker first on the upper tray when none is selected", () => {
    const { projectId: _projectId, projectName: _projectName, ...rest } = defaultProps;
    const { container } = render(
      <CodeComposerAdapter {...rest} folderControl={<span>Choose a Project</span>} />,
    );
    const leading = container.querySelector(".composer-tray__leading");
    const trailing = container.querySelector(".composer-tray__trailing");
    expect(leading?.textContent).toContain("Choose a Project");
    expect(trailing?.textContent).not.toContain("Choose a Project");
  });

  it("hides the branch item on the Code start composer until a Project is chosen", () => {
    const { projectId: _projectId, projectName: _projectName, ...rest } = defaultProps;
    const { container } = render(
      <CodeComposerAdapter {...rest} folderControl={<span>Choose a Project</span>} />,
    );
    const leading = container.querySelector(".composer-tray__leading");
    expect(leading?.textContent).toContain("Choose a Project");
    expect(leading?.textContent).not.toContain("Default branch");
    expect(screen.queryByRole("button", { name: "Base branch" })).toBeNull();
  });

  it("names the branch on one quiet chip once a Project is chosen", () => {
    render(<CodeComposerAdapter {...defaultProps} />);
    expect(whereChip()).toHaveTextContent("development");
    expect(whereChip()).not.toHaveTextContent("This checkout");
    expect(screen.queryByRole("button", { name: "Base branch" })).toBeNull();
  });

  it("creates nothing when New worktree is chosen and sends that choice with the thread", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    render(<CodeComposerAdapter {...defaultProps} onCreateThread={onCreateThread} />);
    await user.click(whereChip());
    await user.click(screen.getByRole("radio", { name: /New worktree/ }));
    expect(whereChip()).toHaveTextContent("New worktree");
    expect(onCreateThread).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
    expect(onCreateThread.mock.calls[0]?.[0]).toMatchObject({ workspace: "managed-worktree" });
  });

  it("shows the branch a prompt-named worktree gets before Send, numbers a taken name, and sends exactly that", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    const execute = vi.fn(async (command: { kind: string; projectId?: string }) => {
      if (command.kind === "list-code-worktree-branch-names") {
        // One local, one that exists only on a remote and one tag: all are taken.
        return {
          kind: "worktree-branch-names-listed",
          projectId: command.projectId,
          names: ["development", "henrik/fix-the-login-bug", "henrik/fix-the-login-bug-2"],
          truncated: false,
        };
      }
      return command.kind === "list-code-worktree-refs"
        ? {
            kind: "worktree-refs-listed",
            projectId: command.projectId,
            refs: [
              { name: "development", kind: "local", isCurrent: true },
              { name: "henrik/fix-the-login-bug", kind: "local" },
            ],
          }
        : undefined;
    });
    render(
      <CodeComposerAdapter
        {...defaultProps}
        newThreadWorkspace="managed-worktree"
        execute={execute as never}
        onCreateThread={onCreateThread}
        worktreeSettings={{ branchPrefix: "henrik/", branchNaming: "prompt" }}
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the login bug");
    await user.click(whereChip());
    await user.click(screen.getByRole("button", { name: /Worktree options/ }));
    expect(await screen.findByText("henrik/fix-the-login-bug-3")).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
    expect(onCreateThread.mock.calls[0]?.[0].deliveryTarget.branchIntent).toBe(
      "henrik/fix-the-login-bug-3",
    );
  });

  it("uses the id name, not words from the prompt, when the host could not list every taken name", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    const execute = vi.fn(async (command: { kind: string; projectId?: string }) =>
      command.kind === "list-code-worktree-branch-names"
        ? {
            kind: "worktree-branch-names-listed",
            projectId: command.projectId,
            names: [],
            truncated: true,
          }
        : undefined,
    );
    render(
      <CodeComposerAdapter
        {...defaultProps}
        newThreadWorkspace="managed-worktree"
        execute={execute as never}
        onCreateThread={onCreateThread}
        worktreeSettings={{ branchPrefix: "henrik/", branchNaming: "prompt" }}
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the login bug");
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith({
        kind: "list-code-worktree-branch-names",
        projectId: defaultProps.projectId,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
    expect(onCreateThread.mock.calls[0]?.[0].deliveryTarget.branchIntent).toMatch(
      /^henrik\/[a-z0-9]+$/,
    );
    expect(onCreateThread.mock.calls[0]?.[0].deliveryTarget.branchIntent).not.toContain("fix");
  });

  it("reads the taken names again when a creation was refused, so the name shown is the one tried next", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn(async () => false as const);
    const execute = vi.fn(async (command: { kind: string; projectId?: string }) =>
      command.kind === "list-code-worktree-branch-names"
        ? {
            kind: "worktree-branch-names-listed",
            projectId: command.projectId,
            names: [],
            truncated: false,
          }
        : undefined,
    );
    render(
      <CodeComposerAdapter
        {...defaultProps}
        newThreadWorkspace="managed-worktree"
        execute={execute as never}
        onCreateThread={onCreateThread}
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the login bug");
    const reads = () =>
      execute.mock.calls.filter(([command]) => command.kind === "list-code-worktree-branch-names")
        .length;
    await waitFor(() => expect(reads()).toBe(1));
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(reads()).toBe(2));
  });

  describe("Suggest name", () => {
    const provider = "00000000-0000-4000-8000-0000000000b1" as never;
    const model = "model-a" as never;
    function executeWith(reply: (command: { kind: string }) => unknown | Promise<unknown>) {
      return vi.fn(
        async (
          command: { kind: string; projectId?: string; draft?: string },
          _signal?: AbortSignal,
        ) => {
          if (command.kind === "list-code-worktree-branch-names") {
            return {
              kind: "worktree-branch-names-listed",
              projectId: command.projectId,
              names: ["development", "octant/fix-login", "v1"],
              truncated: false,
            };
          }
          return command.kind === "list-code-worktree-refs"
            ? {
                kind: "worktree-refs-listed",
                projectId: command.projectId,
                refs: [
                  { name: "development", kind: "local", isCurrent: true },
                  { name: "octant/fix-login", kind: "local" },
                ],
              }
            : reply(command);
        },
      );
    }
    async function openOptions(user: ReturnType<typeof userEvent.setup>) {
      await user.click(whereChip());
      await user.click(screen.getByRole("button", { name: /Worktree options/ }));
    }
    function renderComposer(execute: ReturnType<typeof executeWith>, onCreateThread = vi.fn()) {
      render(
        <CodeComposerAdapter
          {...defaultProps}
          execute={execute as never}
          newThreadWorkspace="managed-worktree"
          onCreateThread={onCreateThread}
          selectedModelId={model}
          selectedProviderInstanceId={provider}
        />,
      );
      return onCreateThread;
    }
    const suggestCalls = (execute: ReturnType<typeof executeWith>) =>
      execute.mock.calls.filter(([command]) => command.kind === "suggest-code-worktree-branch");

    it("asks no model while the person types or sends, and shows the local name", async () => {
      const user = userEvent.setup();
      const execute = executeWith(() => undefined);
      const onCreateThread = renderComposer(execute);
      await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the login bug");
      await openOptions(user);
      expect(
        (screen.getByRole("textbox", { name: "Branch name" }) as HTMLInputElement).value,
      ).toMatch(/^octant\//);
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Create thread" }));
      await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
      expect(suggestCalls(execute)).toHaveLength(0);
    });

    it("sends only the draft and the selected model when asked, shows the proposal, and sends the edited name", async () => {
      const user = userEvent.setup();
      const execute = executeWith((command) =>
        command.kind === "suggest-code-worktree-branch"
          ? {
              kind: "worktree-branch-suggested",
              projectId: defaultProps.projectId,
              words: "fix-login-redirect",
            }
          : undefined,
      );
      const onCreateThread = renderComposer(execute);
      await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the login bug");
      await openOptions(user);
      await user.click(screen.getByRole("button", { name: "Suggest name" }));
      const field = screen.getByRole("textbox", { name: "Branch name" });
      await waitFor(() => expect(field).toHaveValue("octant/fix-login-redirect"));
      expect(suggestCalls(execute)).toEqual([
        [
          {
            kind: "suggest-code-worktree-branch",
            projectId: defaultProps.projectId,
            providerInstanceId: provider,
            modelId: model,
            draft: "fix the login bug",
          },
          expect.any(AbortSignal),
        ],
      ]);
      await user.clear(field);
      await user.type(field, "octant/fix-login-redirect-v2");
      await user.tab();
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Create thread" }));
      await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
      expect(onCreateThread.mock.calls[0]?.[0].deliveryTarget.branchIntent).toBe(
        "octant/fix-login-redirect-v2",
      );
    });

    it("keeps the local name when the model declines, throws, or the message changed meanwhile", async () => {
      const user = userEvent.setup();
      let answer: ((value: unknown) => void) | undefined;
      const replies: Array<() => Promise<unknown>> = [
        async () => ({
          kind: "worktree-branch-suggestion-declined",
          projectId: defaultProps.projectId,
          reason: "failed",
        }),
        async () => {
          throw new Error("offline");
        },
        () => new Promise((resolve) => (answer = resolve)),
      ];
      const execute = executeWith((command) =>
        command.kind === "suggest-code-worktree-branch" ? replies.shift()?.() : undefined,
      );
      renderComposer(execute);
      await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the login bug");
      await openOptions(user);
      const field = screen.getByRole("textbox", { name: "Branch name" });
      const local = (field as HTMLInputElement).value;
      await user.click(screen.getByRole("button", { name: "Suggest name" }));
      expect(await screen.findByText(/could not suggest a name/)).toBeVisible();
      expect(field).toHaveValue(local);
      await user.click(screen.getByRole("button", { name: "Suggest name" }));
      await waitFor(() => expect(suggestCalls(execute)).toHaveLength(2));
      expect(field).toHaveValue(local);

      await user.click(screen.getByRole("button", { name: "Suggest name" }));
      await user.keyboard("{Escape}");
      await user.type(screen.getByRole("textbox", { name: "First message" }), " and logout");
      await act(async () => {
        answer?.({
          kind: "worktree-branch-suggested",
          projectId: defaultProps.projectId,
          words: "stale-words",
        });
      });
      await openOptions(user);
      expect(screen.getByText(/changed while the model was answering/)).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Branch name" })).not.toHaveValue(
        "octant/stale-words",
      );
    });

    it("sends at most the first 2,000 characters of a long draft, after redaction and without a dropped clause", async () => {
      const user = userEvent.setup();
      const execute = executeWith((command) =>
        command.kind === "suggest-code-worktree-branch"
          ? { kind: "worktree-branch-suggested", projectId: defaultProps.projectId, words: "a-b" }
          : undefined,
      );
      renderComposer(execute);
      const draft = `Fix the login bug. The password is hunter2 for staging. ${"more words ".repeat(900)}`;
      fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
        target: { value: draft },
      });
      await openOptions(user);
      await user.click(screen.getByRole("button", { name: "Suggest name" }));
      await waitFor(() => expect(suggestCalls(execute)).toHaveLength(1));
      const sent = suggestCalls(execute)[0]?.[0].draft ?? "";
      expect(sent.length).toBeLessThanOrEqual(2_000);
      expect(sent.startsWith("fix the login bug the")).toBe(true);
      expect(sent).not.toContain("hunter2");
    });

    it("stops a suggestion in flight when the composer goes away or the Project changes", async () => {
      const user = userEvent.setup();
      const signals: AbortSignal[] = [];
      const execute = executeWith((command) =>
        command.kind === "suggest-code-worktree-branch" ? new Promise(() => undefined) : undefined,
      );
      const recording = vi.fn(async (command: { kind: string }, signal?: AbortSignal) => {
        if (command.kind === "suggest-code-worktree-branch" && signal !== undefined) {
          signals.push(signal);
        }
        return execute(command);
      });
      const props = {
        ...defaultProps,
        execute: recording as never,
        newThreadWorkspace: "managed-worktree" as const,
        selectedModelId: model,
        selectedProviderInstanceId: provider,
      };
      const view = render(<CodeComposerAdapter {...props} />);
      await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the login bug");
      await openOptions(user);
      await user.click(screen.getByRole("button", { name: "Suggest name" }));
      await waitFor(() => expect(signals).toHaveLength(1));
      expect(signals[0]?.aborted).toBe(false);
      view.rerender(
        <CodeComposerAdapter
          {...props}
          projectId={"00000000-0000-0000-0000-000000000002" as ProjectId}
        />,
      );
      await waitFor(() => expect(signals[0]?.aborted).toBe(true));

      await user.keyboard("{Escape}");
      await openOptions(user);
      await user.click(screen.getByRole("button", { name: "Suggest name" }));
      await waitFor(() => expect(signals).toHaveLength(2));
      expect(signals[1]?.aborted).toBe(false);
      view.unmount();
      expect(signals[1]?.aborted).toBe(true);
    });

    it("forgets a name chosen for another Project, and shows the name Send will use when a typed one is refused", async () => {
      const user = userEvent.setup();
      const execute = executeWith(() => undefined);
      const props = {
        ...defaultProps,
        execute: execute as never,
        newThreadWorkspace: "managed-worktree" as const,
      };
      const view = render(<CodeComposerAdapter {...props} />);
      await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix it");
      await openOptions(user);
      const field = screen.getByRole("textbox", { name: "Branch name" });
      const derived = (field as HTMLInputElement).value;
      await user.clear(field);
      await user.type(field, "octant/mine");
      await user.tab();
      expect(field).toHaveValue("octant/mine");

      view.rerender(
        <CodeComposerAdapter
          {...props}
          projectId={"00000000-0000-0000-0000-000000000002" as ProjectId}
        />,
      );
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "Branch name" })).toHaveValue(derived),
      );

      const again = screen.getByRole("textbox", { name: "Branch name" });
      await user.clear(again);
      await user.type(again, "v1");
      await user.tab();
      // A tag of that name exists: the field is back on the name that will be sent.
      expect(again).toHaveValue(derived);
      expect(screen.getByText(/"v1" was not used/)).toBeVisible();
      expect(again).toHaveAccessibleDescription(/"v1" was not used/);
    });

    it("refuses a typed name Git would reject or a branch that exists, and returns to the derived name when cleared", async () => {
      const user = userEvent.setup();
      renderComposer(executeWith(() => undefined));
      await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix it");
      await openOptions(user);
      const field = screen.getByRole("textbox", { name: "Branch name" });
      const derived = (field as HTMLInputElement).value;
      await user.clear(field);
      await user.type(field, "has space");
      await user.tab();
      expect(screen.getByText(/Use letters, numbers/)).toBeVisible();
      await user.clear(field);
      await user.type(field, "octant/fix-login");
      await user.tab();
      expect(screen.getByText(/already exists/)).toBeVisible();
      await user.clear(field);
      await user.tab();
      expect(field).toHaveValue(derived);
    });
  });

  it("keeps repository context on the context row above the composer", () => {
    const { container } = render(<CodeComposerAdapter {...defaultProps} />);
    const frame = container.querySelector(".composer");
    const dock = container.querySelector(".composer-tray");
    expect(frame).not.toBeNull();
    expect(dock).not.toBeNull();
    expect(frame?.contains(dock)).toBe(true);
    expect(container.querySelector(".thread-composer__surface")?.contains(dock)).toBe(false);
    expect(dock?.closest(".composer-stack")).toBe(frame?.closest(".composer-stack"));
    expect(dock?.textContent).toContain("development");
    expect(container.querySelector('[class*="context-strip"]')).toBeNull();
  });

  it("renders the mode picker at the default mode", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    expect(html).toContain("Ask first");
    expect(html).toContain('aria-label="Mode: Ask first"');
  });

  it("renders disabled send button when empty", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    expect(html).toContain('aria-label="Create thread"');
    expect(html).toContain("disabled");
  });

  it("blocks Code submission when the selected Project is unavailable", () => {
    const html = renderToStaticMarkup(
      <CodeComposerAdapter {...defaultProps} projectAvailable={false} />,
    );

    expect(html).toContain("That Project is unavailable. Pick another.");
    expect(html).toContain('aria-label="Create thread"');
    expect(html).toContain("disabled");
  });

  it("does not show unavailable-project guidance before a Project is selected", () => {
    const { projectId: _projectId, projectName: _projectName, ...withoutProject } = defaultProps;
    const html = renderToStaticMarkup(
      <CodeComposerAdapter {...withoutProject} projectAvailable={false} />,
    );

    expect(html).not.toContain("The selected Project is unavailable");
    expect(html).not.toContain("Choose a Project to build in");
  });

  it("renders error message when provided", () => {
    const html = renderToStaticMarkup(
      <CodeComposerAdapter {...defaultProps} errorMessage="Checkout failed" />,
    );
    expect(html).toContain("Checkout failed");
    expect(html).toContain('role="alert"');
  });

  it("renders creating state", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} creating />);
    expect(html).toContain("disabled");
  });

  it("renders the multi-model pool control slot in the composer bar", () => {
    const html = renderToStaticMarkup(
      <CodeComposerAdapter {...defaultProps} poolControl={<span>Pool control slot</span>} />,
    );
    expect(html).toContain("Pool control slot");
  });

  it("renders no pool control when the slot is not provided", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    expect(html).not.toContain("Pool control slot");
  });

  it("renders a default-enabled Start from origin control only when server-authoritative remote facts are provided", async () => {
    const user = userEvent.setup();
    render(
      <CodeComposerAdapter
        {...defaultProps}
        // Start from origin only decides where a new worktree branches from,
        // so it belongs to the managed-worktree workspace.
        newThreadWorkspace="managed-worktree"
        worktreeRemoteFacts={{ remotes: ["origin"], defaultRemote: "origin" }}
      />,
    );
    await user.click(whereChip());
    // Where a worktree is fetched from is a rare setting, kept in the
    // Worktree options dialog rather than the menu.
    await user.click(screen.getByRole("button", { name: /Worktree options/ }));
    expect(await screen.findByRole("switch", { name: "Start from origin" })).toBeChecked();
    expect(screen.getByText("Fetch and start from origin/development")).toBeVisible();
  });

  it("F4: disables Start from origin when no server-authoritative remote facts are provided", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    // The control may still render, but it must not be checked/enabled.
    expect(html).not.toContain('aria-checked="true"');
  });

  it("F4: disables Start from origin when remotes are ambiguous", () => {
    const html = renderToStaticMarkup(
      <CodeComposerAdapter
        {...defaultProps}
        worktreeRemoteFacts={{ remotes: ["origin", "upstream"] }}
      />,
    );
    expect(html).not.toContain('aria-checked="true"');
  });

  it("F2: defaults the delivery branch to a unique octant/<id> that does not collide with the base branch", async () => {
    // The delivery section is collapsed by default; verify via interaction
    // that the submitted branchIntent is octant/<id>, not the base branch.
    // See the F2 interaction test below for the authoritative assertion.
    // Here we only confirm the base branch context still renders.
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    expect(html).toContain("development");
  });

  it("omits the Start from origin control when no repository is selected", () => {
    const html = renderToStaticMarkup(
      <CodeComposerAdapter
        defaultPermissionMode="ask-first"
        defaultPermissionPersistence="current-session"
        onCancel={() => {}}
        onCreateThread={() => {}}
        onSelectProvider={() => {}}
        providerGroups={[]}
      />,
    );
    expect(html).not.toContain("Start from origin");
  });
});

// Interaction coverage beyond static markup.
import { createRoot } from "react-dom/client";
import type { ComposerInputElement } from "../../composer/ComposerInput";

describe("CodeComposerAdapter interactions", () => {
  it("defaults Start from origin when authoritative remote facts arrive after mount", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<CodeComposerAdapter {...defaultProps} newThreadWorkspace="managed-worktree" />);
    });
    await act(async () => {
      whereChip().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      screen
        .getByRole("button", { name: /Worktree options/ })
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const originSwitch = () => screen.getByRole("switch", { name: "Start from origin" });
    expect(originSwitch()).toHaveAttribute("aria-checked", "false");

    await act(async () => {
      root.render(
        <CodeComposerAdapter
          {...defaultProps}
          newThreadWorkspace="managed-worktree"
          worktreeRemoteFacts={{ remotes: ["origin"], defaultRemote: "origin" }}
        />,
      );
    });

    try {
      expect(originSwitch()).toHaveAttribute("aria-checked", "true");
    } finally {
      // Unmounted even when the check fails, so a failure here cannot leave a
      // second composer in the document for the tests after it.
      root.unmount();
      container.remove();
    }
  });

  it("submits the access posture the composer chose", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    render(
      <CodeComposerAdapter
        {...defaultProps}
        defaultPermissionMode="ask-first"
        onCreateThread={onCreateThread}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "First message" }), "Plan this change");
    await user.click(screen.getByRole("button", { name: /^Mode:/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Plan/ }));
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
    // The posture rides on the create command; a callback the shell merely
    // observes would leave the thread created with the Project default.
    expect(onCreateThread.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Plan this change",
      executionPolicy: "plan",
    });
  });

  it("keeps the chosen approval mode when the draft switches Project", async () => {
    const user = userEvent.setup();
    const onPermissionModeChange = vi.fn();
    const rendered = render(
      <CodeComposerAdapter {...defaultProps} onPermissionModeChange={onPermissionModeChange} />,
    );

    await user.click(screen.getByRole("button", { name: /^Mode:/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Plan/ }));
    expect(onPermissionModeChange).toHaveBeenCalledWith("plan");

    rendered.unmount();
    render(
      <CodeComposerAdapter
        {...defaultProps}
        defaultPermissionMode="plan"
        onPermissionModeChange={onPermissionModeChange}
      />,
    );
    expect(screen.getByRole("button", { name: /^Mode:/ })).toHaveAccessibleName("Mode: Plan");
  });

  it("submits on Enter and cancels on Escape", async () => {
    const onCreateThread = vi.fn();
    const onCancel = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          projectId={"00000000-0000-0000-0000-000000000001" as any}
          defaultPermissionMode="ask-first"
          defaultPermissionPersistence="current-session"
          providerGroups={[]}
          onSelectProvider={() => {}}
          onCreateThread={onCreateThread}
          onCancel={onCancel}
        />,
      );
    });
    const textarea = container.querySelector<ComposerInputElement>(".composer-input");
    expect(textarea).not.toBeNull();
    await act(async () => {
      if (textarea !== null) textarea.value = "Ship the fix";
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCreateThread).toHaveBeenCalled();
    await act(async () => {
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalled();
    root.unmount();
    container.remove();
  });

  /**
   * A Code thread belongs to a Project. Enter must not start a
   * first turn while no Project is chosen, or the thread would run against a
   * root nobody picked.
   */
  it("refuses to start the first turn until a Project is chosen, and says why", async () => {
    const onCreateThread = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          defaultPermissionMode="ask-first"
          defaultPermissionPersistence="current-session"
          providerGroups={[]}
          onSelectProvider={() => {}}
          onCreateThread={onCreateThread}
          onCancel={() => {}}
        />,
      );
    });
    const textarea = container.querySelector<ComposerInputElement>(".composer-input");
    await act(async () => {
      if (textarea !== null) textarea.value = "Ship the fix";
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onCreateThread).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Choose a Project first. A Code task works in a folder.",
    );
    root.unmount();
    container.remove();
  });

  it("F4: carries startFromOrigin=false on the submit input when no server-authoritative remote facts are provided", async () => {
    const onCreateThread = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          projectId={"00000000-0000-0000-0000-000000000001" as any}
          projectName="My Repo"
          defaultPermissionMode="ask-first"
          defaultPermissionPersistence="current-session"
          providerGroups={[]}
          onSelectProvider={() => {}}
          onCreateThread={onCreateThread}
          onCancel={() => {}}
        />,
      );
    });
    const textarea = container.querySelector<ComposerInputElement>(".composer-input");
    await act(async () => {
      if (textarea !== null) textarea.value = "Ship the fix";
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeSource: { startFromOrigin: false, remoteName: "origin" },
      }),
    );
    root.unmount();
    container.remove();
  });

  it("F2: carries a non-colliding octant/<id> branchIntent on the submit input", async () => {
    const onCreateThread = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          projectId={"00000000-0000-0000-0000-000000000001" as any}
          projectName="My Repo"
          defaultPermissionMode="ask-first"
          defaultPermissionPersistence="current-session"
          providerGroups={[]}
          onSelectProvider={() => {}}
          onCreateThread={onCreateThread}
          onCancel={() => {}}
        />,
      );
    });
    const textarea = container.querySelector<ComposerInputElement>(".composer-input");
    await act(async () => {
      if (textarea !== null) textarea.value = "Ship the fix";
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryTarget: expect.objectContaining({
          branchIntent: expect.stringMatching(/^octant\//),
        }),
      }),
    );
    // The branchIntent must not equal the base branch.
    const call = onCreateThread.mock.calls[0]![0] as {
      deliveryTarget: { branchIntent: string; proposedBaseBranch: string };
    };
    expect(call.deliveryTarget.branchIntent).not.toBe(call.deliveryTarget.proposedBaseBranch);
    root.unmount();
    container.remove();
  });

  it("preserves an explicitly selected remote ref when remotes are ambiguous", async () => {
    const onCreateThread = vi.fn();
    const execute = vi.fn(async (command: { kind: string }) => {
      if (command.kind === "list-code-worktree-refs") {
        return {
          kind: "worktree-refs-listed",
          projectId: "00000000-0000-0000-0000-000000000001",
          refs: [
            { name: "origin/feature-only", kind: "remote", remoteName: "origin" },
            { name: "upstream/main", kind: "remote", remoteName: "upstream" },
          ],
        };
      }
      return undefined;
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          {...defaultProps}
          execute={execute as never}
          newThreadWorkspace="managed-worktree"
          onCreateThread={onCreateThread}
          worktreeRemoteFacts={{ remotes: ["origin", "upstream"] }}
        />,
      );
    });

    await act(async () => {
      whereChip().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const trigger = document.querySelector('button[aria-label^="Start from"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((node) =>
      node.textContent?.includes("origin/feature-only"),
    );
    expect(option).not.toBeUndefined();
    await act(async () => {
      option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const textarea = container.querySelector<ComposerInputElement>(".composer-input");
    await act(async () => {
      if (textarea !== null) textarea.value = "Ship the remote branch";
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeSource: { startFromOrigin: true, remoteName: "origin" },
        deliveryTarget: expect.objectContaining({ proposedBaseBranch: "feature-only" }),
      }),
    );
    root.unmount();
    container.remove();
  });

  it("reads what the task delivers from the prompt and writes it to the thread", async () => {
    const onCreateThread = vi.fn();
    const user = userEvent.setup();
    render(<CodeComposerAdapter {...defaultProps} onCreateThread={onCreateThread} />);

    // Nothing about delivery is asked up front: the band carries no control for it.
    expect(screen.queryByRole("button", { name: "Delivers" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("First message"), "open a pull request for the parser");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    expect(onCreateThread).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deliveryTarget: expect.objectContaining({ outcomeKind: "opened-pr" }),
      }),
    );

    await user.clear(screen.getByLabelText("First message"));
    await user.type(screen.getByLabelText("First message"), "explain why the parser drops tokens");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    expect(onCreateThread).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deliveryTarget: expect.objectContaining({ outcomeKind: "investigation-result" }),
      }),
    );
  });

  it("names the branch the repository is actually on rather than a stock default", async () => {
    const projectId = "00000000-0000-0000-0000-000000000009";
    const execute = vi.fn(async (command: { kind: string; projectId?: string }) => {
      if (command.kind !== "list-code-worktree-refs") return undefined;
      return {
        kind: "worktree-refs-listed",
        projectId: command.projectId,
        refs: [
          { name: "development", kind: "local" },
          { name: "main", kind: "local", isCurrent: true },
        ],
      };
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          {...defaultProps}
          execute={execute as never}
          projectId={projectId as never}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The tray states where a new task starts from, so it has to read the
    // checkout rather than assume a branch name that many repositories lack.
    const chip = container.querySelector('button[aria-label^="Where this thread works"]');
    expect(chip?.textContent).toContain("main");
    expect(chip?.textContent).not.toContain("development");
    root.unmount();
    container.remove();
  });

  it("says the base branch is assumed when a thread is sent before the host has named one", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    const { baseBranch: _seeded, ...unseeded } = defaultProps;
    render(<CodeComposerAdapter {...unseeded} onCreateThread={onCreateThread} />);
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
    expect(onCreateThread.mock.calls[0]?.[0]).toMatchObject({ baseBranchAssumed: true });
  });

  it("starts a draft opened for a failing branch from that branch even when the checkout is on another", async () => {
    const projectId = "00000000-0000-0000-0000-000000000009";
    const onCreateThread = vi.fn();
    const execute = vi.fn(async (command: { kind: string; projectId?: string }) => {
      if (command.kind !== "list-code-worktree-refs") return undefined;
      return {
        kind: "worktree-refs-listed",
        projectId: command.projectId,
        refs: [
          { name: "main", kind: "local", isCurrent: true },
          { name: "fix/parser", kind: "local" },
        ],
      };
    });
    const user = userEvent.setup();
    const { baseBranch: _seed, ...unseeded } = defaultProps;
    render(
      <CodeComposerAdapter
        {...unseeded}
        branchName="fix/parser"
        execute={execute as never}
        onCreateThread={onCreateThread}
        projectId={projectId as never}
      />,
    );
    await waitFor(() => expect(execute).toHaveBeenCalled());

    await user.click(whereChip());
    expect(screen.getByRole("button", { name: /^Start from/ })).toHaveTextContent("fix/parser");
    await user.keyboard("{Escape}");
    await user.type(screen.getByLabelText("First message"), "Fix the failing parser check");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() =>
      expect(onCreateThread).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace: "managed-worktree",
          deliveryTarget: expect.objectContaining({ proposedBaseBranch: "fix/parser" }),
        }),
      ),
    );
  });

  it("opens the Start from picker on a draft asked for another branch even when the default is this checkout", async () => {
    const projectId = "00000000-0000-0000-0000-000000000009";
    const execute = vi.fn(async (command: { kind: string; projectId?: string }) => {
      if (command.kind !== "list-code-worktree-refs") return undefined;
      return {
        kind: "worktree-refs-listed",
        projectId: command.projectId,
        refs: [
          { name: "development", kind: "local", isCurrent: true },
          { name: "fix/parser", kind: "local" },
        ],
      };
    });
    render(
      <CodeComposerAdapter
        {...defaultProps}
        execute={execute as never}
        projectId={projectId as never}
        startFromOpen
      />,
    );

    // The intent lands the person in the picker itself — the Where menu and
    // the Start from list are open, the refs it lists were just read, and the
    // worktree choice it implies is already made.
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "list-code-worktree-refs" }),
      ),
    );
    expect(await screen.findByRole("listbox", { name: "Refs" })).toBeVisible();
    expect(await screen.findByRole("option", { name: /fix\/parser/ })).toBeVisible();
    expect(screen.getByRole("radio", { name: /New worktree/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Start from/ })).toBeVisible();
  });

  it("clears stale worktree refs when the selected project changes", async () => {
    const firstProject = "00000000-0000-0000-0000-000000000001";
    const secondProject = "00000000-0000-0000-0000-000000000002";
    const execute = vi.fn(async (command: { kind: string; projectId?: string }) => {
      if (command.kind !== "list-code-worktree-refs") return undefined;
      return {
        kind: "worktree-refs-listed",
        projectId: command.projectId,
        refs:
          command.projectId === firstProject
            ? [{ name: "project-a-only", kind: "local", isCurrent: true }]
            : [{ name: "project-b-only", kind: "local", isCurrent: true }],
      };
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          {...defaultProps}
          execute={execute as never}
          newThreadWorkspace="managed-worktree"
          projectId={firstProject as never}
        />,
      );
    });
    const trigger = () => document.querySelector('button[aria-label^="Start from"]');
    await act(async () => {
      whereChip().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("project-a-only");

    await act(async () => {
      root.render(
        <CodeComposerAdapter
          {...defaultProps}
          execute={execute as never}
          newThreadWorkspace="managed-worktree"
          projectId={secondProject as never}
          projectName="Other Repo"
        />,
      );
    });
    expect(document.body.textContent).not.toContain("project-a-only");
    await act(async () => {
      trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain("project-a-only");
    expect(document.body.textContent).toContain("project-b-only");
    // The tray names the new Project's head. Left standing, the previous
    // Project's selection both showed the wrong branch and told the adoption
    // that this Project's head had already been overruled.
    expect(trigger()?.textContent).toContain("project-b-only");
    root.unmount();
    container.remove();
  });

  it("says a text-only model cannot take a pasted image instead of attaching it", async () => {
    render(
      <CodeComposerAdapter
        {...defaultProps}
        providerGroups={[
          {
            driverLabel: "OpenCode",
            endpointHost: "local",
            executionHost: "local",
            instance: {
              id: "80000000-0000-4000-8000-0000000000a1",
              displayName: "Local OpenCode",
            },
            readiness: "ready",
            sections: [
              {
                label: "Models",
                models: [
                  {
                    model: {
                      id: "model-one",
                      displayName: "Model One",
                      inputModalities: ["text"],
                    },
                  },
                ],
              },
            ],
          } as never,
        ]}
        selectedProviderInstanceId={"80000000-0000-4000-8000-0000000000a1" as never}
        selectedModelId={"model-one" as never}
      />,
    );

    const file = new File([new Uint8Array([137, 80, 78])], "pasted.png", { type: "image/png" });
    fireEvent.paste(screen.getByLabelText("First message"), {
      clipboardData: { files: [file], items: [] },
    });
    const refusal = await screen.findByText("This model cannot read images. Pick one that can.");
    expect(refusal.closest(".composer-notices")).not.toBeNull();
    expect(screen.queryByAltText("pasted.png")).not.toBeInTheDocument();
  });

  it("keeps Code checkout choices after Settings remounts the draft", async () => {
    const user = userEvent.setup();
    const drafts = createNewTaskDrafts();
    drafts.writeCodeCheckout("code:pane", {
      baseBranch: "fix/login",
      baseBranchChosen: true,
      workspaceOverride: "managed-worktree",
      worktreeRemote: "origin",
      startFromOriginOverride: true,
    });
    const view = (
      <NewTaskDraftsContext.Provider value={drafts}>
        <NewTaskDraftScopeContext.Provider value="code:pane">
          <CodeComposerAdapter
            {...defaultProps}
            newThreadWorkspace="current-checkout"
            worktreeRemoteFacts={{ remotes: ["origin"], defaultRemote: "origin" }}
          />
        </NewTaskDraftScopeContext.Provider>
      </NewTaskDraftsContext.Provider>
    );
    const rendered = render(view);
    expect(whereChip()).toHaveTextContent("New worktree");
    await user.click(whereChip());
    await user.click(screen.getByRole("button", { name: /Worktree options/ }));
    expect(await screen.findByRole("switch", { name: /Start from origin/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    rendered.unmount();
    render(view);

    expect(whereChip()).toHaveTextContent("New worktree");
    await user.click(whereChip());
    expect(screen.getByRole("button", { name: /^Start from/ })).toHaveTextContent("fix/login");
    expect(await screen.findByRole("radio", { name: /New worktree/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("button", { name: /Worktree options/ }));
    expect(await screen.findByRole("switch", { name: /Start from origin/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("keeps a pane's access posture after Settings remounts the draft", async () => {
    const user = userEvent.setup();
    const drafts = createNewTaskDrafts();
    const view = (
      <NewTaskDraftsContext.Provider value={drafts}>
        <NewTaskDraftScopeContext.Provider value="code:pane">
          <CodeComposerAdapter {...defaultProps} defaultPermissionMode="full-access" />
        </NewTaskDraftScopeContext.Provider>
      </NewTaskDraftsContext.Provider>
    );
    const rendered = render(view);
    await user.click(screen.getByRole("button", { name: /^Mode:/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Plan/ }));
    expect(screen.getByRole("button", { name: /^Mode:/ })).toHaveAccessibleName("Mode: Plan");

    rendered.unmount();
    render(view);

    expect(screen.getByRole("button", { name: /^Mode:/ })).toHaveAccessibleName("Mode: Plan");
  });

  describe("in a Project on a server", () => {
    const pickerGroup = (
      id: string,
      displayName: string,
      runtime: PickerGroup["runtime"],
      modelName: string,
    ): PickerGroup => ({
      instance: decodeProviderInstance({
        id,
        displayName,
        driverKind: "codex",
        configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: "2026-09-15T10:00:00.000Z",
        updatedAt: "2026-09-15T10:00:00.000Z",
      }),
      runtime,
      readiness: "ready",
      driverLabel: displayName,
      endpointHost: undefined,
      executionHost: "Local host",
      sections: [
        {
          id: "all-models",
          label: "Models",
          models: [
            {
              model: {
                id: decodeProviderModelId(modelName),
                displayName: modelName,
                reasoning: "unsupported",
                inputModalities: ["text"],
                source: "discovered",
                verification: "verified",
                options: [],
              },
              badges: [],
              toolCapable: true,
            },
          ],
        },
      ],
    });
    const harness = pickerGroup(
      "80000000-0000-4000-8000-0000000000b1",
      "Octant",
      "octant-harness",
      "harness-model",
    );
    const cli = pickerGroup(
      "80000000-0000-4000-8000-0000000000b2",
      "Local Codex",
      "provider",
      "cli-model",
    );
    const serverProps = {
      ...defaultProps,
      projectName: "Service",
      providerGroups: [harness, cli],
      selectedProviderInstanceId: harness.instance.id,
      selectedModelId: decodeProviderModelId("harness-model"),
      server: { location: "devbox:/home/build/service" },
    };

    it("names the folder, lists the server's branches, and starts in the bound folder at any access level", async () => {
      const user = userEvent.setup();
      const onCreateThread = vi.fn();
      const execute = vi.fn(async (command: { readonly kind: string }) =>
        command.kind === "list-code-worktree-refs"
          ? {
              kind: "worktree-refs-listed",
              projectId: serverProps.projectId,
              refs: [{ name: "main", kind: "local", isCurrent: true }],
            }
          : undefined,
      );
      render(
        <CodeComposerAdapter
          {...serverProps}
          defaultPermissionMode="full-access"
          defaultPermissionPersistence="project-default"
          execute={execute as never}
          newThreadWorkspace="managed-worktree"
          onCreateThread={onCreateThread}
        />,
      );

      expect(screen.getByText("devbox:/home/build/service")).toBeVisible();
      // A habit remembered on this host does not choose a worktree on a server.
      expect(whereChip()).not.toHaveTextContent("New worktree");
      await waitFor(() => expect(whereChip()).toHaveTextContent("main"));
      expect(screen.getByRole("button", { name: /^Mode:/ })).toHaveAccessibleName(
        "Mode: Full access",
      );
      await user.click(screen.getByRole("button", { name: /^Mode:/ }));
      const levels = (await screen.findAllByRole("menuitemradio")).map((item) => item.textContent);
      expect(levels.length).toBeGreaterThan(2);
      await user.keyboard("{Escape}");

      await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the build");
      await user.click(screen.getByRole("button", { name: "Create thread" }));
      await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
      expect(onCreateThread.mock.calls[0]?.[0]).toMatchObject({
        executionPolicy: "full-access",
        permissionPersistence: "current-session",
        workspace: "current-checkout",
        deliveryTarget: { proposedBaseBranch: "main" },
      });
      expect(onCreateThread.mock.calls[0]?.[0]).not.toHaveProperty("computerUseSelection");
      expect(onCreateThread.mock.calls[0]?.[0]).not.toHaveProperty("extensionSelections");
    });

    it("starts a thread in its own worktree on the server when the person picks one", async () => {
      const user = userEvent.setup();
      const onCreateThread = vi.fn();
      render(<CodeComposerAdapter {...serverProps} onCreateThread={onCreateThread} />);

      await user.click(whereChip());
      await user.click(await screen.findByRole("radio", { name: /New worktree/ }));
      await user.keyboard("{Escape}");
      await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the build");
      await user.click(screen.getByRole("button", { name: "Create thread" }));
      await waitFor(() => expect(onCreateThread).toHaveBeenCalledTimes(1));
      expect(onCreateThread.mock.calls[0]?.[0]).toMatchObject({ workspace: "managed-worktree" });
    });

    it("lists other providers unavailable with the reason, and starts nothing on one", async () => {
      const user = userEvent.setup();
      const onCreateThread = vi.fn();
      render(
        <CodeComposerAdapter
          {...serverProps}
          selectedProviderInstanceId={cli.instance.id}
          selectedModelId={decodeProviderModelId("cli-model")}
          onCreateThread={onCreateThread}
        />,
      );

      await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the build");
      expect(screen.getByRole("button", { name: "Create thread" })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Runs on this computer's files; a Project on a server runs on the Octant Harness, or on a runtime that runs on the server itself.",
      );
      await user.click(screen.getByRole("button", { name: "Provider and model" }));
      await user.click(screen.getByRole("option", { name: "Local Codex" }));
      expect(screen.getByRole("option", { name: "Cli Model" })).toBeDisabled();
      expect(onCreateThread).not.toHaveBeenCalled();
    });

    it("offers a provider that runs on the server itself, such as Codex, and starts a thread on it", async () => {
      const user = userEvent.setup();
      render(
        <CodeComposerAdapter
          {...serverProps}
          providerGroups={[harness, { ...cli, serverPlacement: "supported" }]}
          selectedProviderInstanceId={cli.instance.id}
          selectedModelId={decodeProviderModelId("cli-model")}
        />,
      );
      await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix the build");
      expect(screen.queryByText(/Runs on this computer's files/)).toBeNull();
      expect(screen.getByRole("button", { name: "Create thread" })).toBeEnabled();
      // Said once per server and provider: its sandbox is its own, and its
      // model requests leave from the server.
      expect(screen.getByText(/Octant can't sandbox anything on that server/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Got it" }));
      expect(screen.queryByText(/Octant can't sandbox anything on that server/)).toBeNull();
      await user.click(screen.getByRole("button", { name: "Details" }));
      expect(screen.getByText(/leave from devbox, not from this computer/)).toBeInTheDocument();
    });
  });
});

it("refuses a native folder as an attachment when the desktop extraction bridge is unavailable", async () => {
  render(<CodeComposerAdapter {...defaultProps} />);
  const input = screen.getByRole("textbox", { name: "First message" });
  fireEvent.drop(input, { dataTransfer: nativeFolderTransfer() });
  expect(await screen.findByText(/Folder drops need the desktop app/)).toBeVisible();
});
