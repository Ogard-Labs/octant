import {
  decodeChatBootstrap,
  decodeChatThreadView,
  type ChatCommand,
} from "@octant/contracts/chat";
import type { SideChatSidecar } from "@octant/contracts";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { ThreadMentionClient } from "@octant/client-runtime";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ChatController } from "./useChatController";
import { ChatWorkspace } from "./ChatWorkspace";

const now = "2026-07-20T08:00:00.000Z";
const threadId = "00000000-0000-4000-8000-000000000921";
const providerId = "10000000-0000-4000-8000-000000000001";
const turnId = "00000000-0000-4000-8000-000000000931";
const contentId = "00000000-0000-4000-8000-000000000932";
const attemptId = "00000000-0000-4000-8000-000000000933";

function controllerFixture(
  overrides: Partial<ChatController> = {},
  thread: Record<string, unknown> = {},
): ChatController {
  const view = decodeChatThreadView({
    thread: {
      id: threadId,
      title: "Calm planning",
      lifecycle: "active",
      providerInstanceId: providerId,
      modelId: "model-a",
      researchEnabled: false,
      researchRouting: "automatic",
      personalityInstructions: "Be calm.",
      version: 3,
      createdAt: now,
      updatedAt: now,
      ...thread,
    },
    turns: [],
    lastSequence: 4,
    contents: [],
    attachments: [],
    citations: [],
    workListVersion: 7,
    followUpVersion: 9,
    workItems: [
      {
        id: "00000000-0000-4000-8000-000000000922",
        threadId,
        title: "Confirm direction",
        status: "blocked",
        position: 0,
        origin: "user",
        version: 2,
        createdAt: now,
        updatedAt: now,
      },
    ],
    followUp: {
      threadId,
      state: "open",
      origin: "manual",
      reason: "Review the direction.",
      triggerSequence: 4,
      acknowledgedThroughSequence: 0,
      createdAt: now,
    },
  });
  const bootstrap = decodeChatBootstrap({
    settings: {
      defaultProviderInstanceId: providerId,
      defaultModelId: "model-a",
      defaultResearchEnabled: false,
      defaultResearchRouting: "automatic",
      searxngBaseUrl: "http://127.0.0.1:8080",
      defaultPersonalityInstructions: "Be calm.",
      version: 1,
      updatedAt: now,
    },
    threads: [view.thread],
  });
  return {
    activeView: view,
    bootstrap,
    errorMessage: undefined,
    execute: vi.fn(async () => undefined),
    navigation: [],
    pendingDraft: "Ship this plan",
    retry: vi.fn(async () => undefined),
    sendTurn: vi.fn(async () => true),
    setPendingDraft: vi.fn(),
    status: "ready",
    upload: vi.fn(),
    discard: vi.fn(async (input) => ({
      id: input.attachmentId,
      threadId: input.threadId,
      displayName: "discarded",
      mediaType: "image/png",
      byteLength: 0,
      digest: "a".repeat(64),
      status: "purged",
      createdAt: now,
    })),
    ...overrides,
  } as ChatController;
}

function viewWithAttempt(
  outcome: "streaming" | "completed" | "failed" | "cancelled" | "interrupted" | "waiting",
) {
  return decodeChatThreadView({
    ...controllerFixture().activeView!,
    turns: [
      {
        id: turnId,
        threadId,
        sequence: 1,
        userMessageRef: { contentId, digest: "a".repeat(64), byteLength: 12 },
        attachmentIds: [],
        attempts: [
          {
            id: attemptId,
            turnId,
            threadId,
            providerInstanceId: providerId,
            providerSessionId: "20000000-0000-4000-8000-000000000001",
            modelId: "model-a",
            contextManifestId: "30000000-0000-4000-8000-000000000001",
            outcome,
            responseRefs: [],
            citationIds: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      },
    ],
    contents: [
      {
        contentId,
        role: "user",
        body: "Ship the transcript first.",
        digest: "a".repeat(64),
        byteLength: 25,
      },
    ],
  });
}

/** A view with one turn whose only attempt failed, so it can be edited or retried. */
function viewWithFailedAttempt() {
  return viewWithAttempt("failed");
}

/** Paste clipboard images into the composer the way the OS delivers them. */
function pasteImages(target: HTMLElement, files: ReadonlyArray<File>): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      types: ["Files"],
    },
  });
  fireEvent(target, event);
}

function providerSnapshot(
  driverKind: "opencode" | "openai-compatible" = "opencode",
): ProviderRegistrySnapshot {
  const capability = "supported" as const;
  return {
    defaults: { permissionPersistence: "current-session", version: 1 as never },
    instances: [
      {
        id: providerId as never,
        displayName: "OpenCode",
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1 as never,
        createdAt: now as never,
        updatedAt: now as never,
        driverKind: driverKind as never,
        configuration: { kind: "opencode-cli", binaryPath: "/usr/local/bin/opencode" } as never,
      },
    ],
    observedStates: [
      {
        instanceId: providerId as never,
        readiness: "ready",
        processState: "running",
        models: [
          {
            id: "model-a" as never,
            displayName: "Model A",
            reasoning: capability,
            inputModalities: ["text", "image"],
            options: [],
            source: "discovered",
            verification: "verified",
          },
        ],
        capabilities: {
          streaming: capability,
          resume: capability,
          interruption: capability,
          approvals: capability,
          userQuestions: capability,
          reasoning: capability,
          usage: capability,
          toolActivity: capability,
          fileChanges: "unsupported",
          diffs: "unsupported",
          taskProgress: capability,
          nativeChildAgents: "unsupported",
          nativeAttachments: capability,
          nativeWebResearch: capability,
          appManagedTools: capability,
          citations: capability,
        },
        observedAt: now as never,
      },
    ],
  };
}

/** Provider snapshot whose first model declares two selectable options. */
function providerSnapshotWithModelOptions(): ProviderRegistrySnapshot {
  const snapshot = providerSnapshot();
  const baseModel = snapshot.observedStates[0]!.models[0]!;
  return {
    ...snapshot,
    observedStates: [
      {
        ...snapshot.observedStates[0]!,
        models: [
          {
            ...baseModel,
            options: [
              { id: "effort", displayName: "Effort", kind: "selection", values: ["low", "high"] },
              { id: "service-tier", displayName: "Speed", kind: "selection", values: ["fast"] },
            ],
          },
          { ...baseModel, id: "model-b" as never, displayName: "Model B" },
        ],
      },
    ],
  };
}

function extensionClient(): ExtensionClient {
  const digest = `sha256:${"a".repeat(64)}`;
  const catalogEpoch = `sha256:${"c".repeat(64)}`;
  const qualifiedSkillId = `catalog:octant~build-tools:instructions:${digest}`;
  const packageState = {
    extensionId: "30000000-0000-4000-8000-000000000001",
    packageId: "31000000-0000-4000-8000-000000000001",
    slug: "build-tools",
    displayName: "Build tools",
    stateVersion: 4,
    version: "1.2.3",
    digest,
    source: { kind: "catalog", catalogId: "octant", entryId: "build-tools" },
    compatibility: { platforms: ["macos"], modes: ["chat"], providerFamilies: [] },
    activation: {
      installed: true,
      trusted: true,
      pluginDesired: true,
      componentDesired: true,
      compatible: true,
      policyAllowed: true,
      quarantined: false,
      draining: false,
      broken: false,
      unavailable: false,
      interrupted: false,
      waiting: false,
    },
    components: [
      {
        component: {
          id: "instructions",
          kind: "skill-instructions",
          displayName: "Build guidance",
          declaredCapabilities: ["instructions"],
          contentReference: "content:instructions",
        },
        activation: {
          installed: true,
          trusted: true,
          pluginDesired: true,
          componentDesired: true,
          compatible: true,
          policyAllowed: true,
          quarantined: false,
          draining: false,
          broken: false,
          unavailable: false,
          interrupted: false,
          waiting: false,
        },
        effectiveState: { kind: "effective" },
      },
    ],
    diagnostics: [],
  } as const;
  return {
    snapshot: vi.fn(async () => ({
      sequence: 8,
      snapshotAt: now,
      packages: [packageState],
      skills: [
        {
          skill: {
            qualifiedId: qualifiedSkillId,
            name: "instructions",
            sourceKind: "catalog",
            digest,
            available: true,
          },
          source: packageState.source,
          version: "1.2.3",
          displayName: "Build instructions",
          provenance: { reviewed: true },
          contentBytes: 128,
          reviewed: true,
          desiredEnabled: true,
          effectiveState: { kind: "effective" },
        },
      ],
      collisions: [],
    })) as never,
    effectiveState: vi.fn(async () => ({
      sequence: 8,
      snapshotAt: now,
      scope: {
        hostId: "local",
        mode: "chat",
        projectId: null,
        threadId,
        providerFamily: "opencode",
      },
      catalogEpoch,
      catalogStatus: "available",
      stale: false,
      packages: [
        {
          ...packageState,
          components: packageState.components.map((component) => ({
            ...component,
            policy: {
              revision: 1,
              projectRevision: 1,
              threadRevision: 1,
              hostAllowed: true,
              modeAllowed: true,
              projectAllowed: true,
              threadAllowed: true,
              policyAllowed: true,
            },
            contextContribution: { kind: "zero", reason: "not-selected" },
          })),
        },
      ],
      collisions: [],
    })) as never,
    execute: vi.fn() as never,
    importLocalPluginReceipt: vi.fn() as never,
    listToolApprovals: vi.fn(async () => []) as never,
    decideToolApproval: vi.fn(async () => true) as never,
  };
}

describe("ChatWorkspace", () => {
  it("queues a follow-up while a turn is running and sends it once on completion", async () => {
    const user = userEvent.setup();
    const sendTurn = vi.fn(async () => true);
    function Harness() {
      const [draft, setDraft] = useState("Next step");
      const [view, setView] = useState(viewWithAttempt("streaming"));
      return (
        <>
          <ChatWorkspace
            controller={controllerFixture({
              activeView: view,
              pendingDraft: draft,
              sendTurn,
              setPendingDraft: setDraft,
            })}
            providerSnapshot={providerSnapshot()}
          />
          <button onClick={() => setView(viewWithAttempt("completed"))} type="button">
            Complete turn
          </button>
        </>
      );
    }
    render(<Harness />);

    expect(screen.getByLabelText("Message")).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    expect(sendTurn).not.toHaveBeenCalled();
    expect(
      screen.getByText("This message is queued and will send when the response finishes."),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Complete turn" }));
    await waitFor(() => expect(sendTurn).toHaveBeenCalledOnce());
    expect(sendTurn).toHaveBeenCalledWith("Next step", [], [], [], [], []);
  });

  it("leaves a queued follow-up unsent when the turn is cancelled or fails", async () => {
    const user = userEvent.setup();
    const sendTurn = vi.fn(async () => true);
    function Harness() {
      const [draft, setDraft] = useState("Hold this");
      const [view, setView] = useState(viewWithAttempt("streaming"));
      return (
        <>
          <ChatWorkspace
            controller={controllerFixture({
              activeView: view,
              pendingDraft: draft,
              sendTurn,
              setPendingDraft: setDraft,
            })}
            providerSnapshot={providerSnapshot()}
          />
          <button onClick={() => setView(viewWithAttempt("cancelled"))} type="button">
            Cancel turn
          </button>
          <button onClick={() => setView(viewWithAttempt("failed"))} type="button">
            Fail turn
          </button>
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    await user.click(screen.getByRole("button", { name: "Cancel turn" }));
    await waitFor(() =>
      expect(
        screen.getByText("The response was cancelled. The queued message was not sent."),
      ).toBeVisible(),
    );
    expect(sendTurn).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message")).toHaveValue("Hold this");
  });

  it("lets the user discard a queued follow-up before it fires", async () => {
    const user = userEvent.setup();
    const sendTurn = vi.fn(async () => true);
    function Harness() {
      const [draft, setDraft] = useState("Drop this");
      const [view, setView] = useState(viewWithAttempt("streaming"));
      return (
        <>
          <ChatWorkspace
            controller={controllerFixture({
              activeView: view,
              pendingDraft: draft,
              sendTurn,
              setPendingDraft: setDraft,
            })}
            providerSnapshot={providerSnapshot()}
          />
          <button onClick={() => setView(viewWithAttempt("completed"))} type="button">
            Complete turn
          </button>
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    await user.click(screen.getByRole("button", { name: "Discard queued message" }));
    expect(screen.getByLabelText("Message")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Complete turn" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeVisible());
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("does not send a queued follow-up after the composer unmounts", async () => {
    const user = userEvent.setup();
    const sendTurn = vi.fn(async () => true);
    function Harness({ open }: { readonly open: boolean }) {
      const [draft, setDraft] = useState("Do not send this");
      return open ? (
        <ChatWorkspace
          controller={controllerFixture({
            activeView: viewWithAttempt("streaming"),
            pendingDraft: draft,
            sendTurn,
            setPendingDraft: setDraft,
          })}
          providerSnapshot={providerSnapshot()}
        />
      ) : null;
    }
    const { rerender } = render(<Harness open />);
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    rerender(<Harness open={false} />);
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("holds a queued follow-up when the running attempt ends as waiting", async () => {
    const user = userEvent.setup();
    const sendTurn = vi.fn(async () => true);
    function Harness() {
      const [draft, setDraft] = useState("Hold this");
      const [view, setView] = useState(viewWithAttempt("streaming"));
      return (
        <>
          <ChatWorkspace
            controller={controllerFixture({
              activeView: view,
              pendingDraft: draft,
              sendTurn,
              setPendingDraft: setDraft,
            })}
            providerSnapshot={providerSnapshot()}
          />
          <button onClick={() => setView(viewWithAttempt("waiting"))} type="button">
            Wait
          </button>
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    await user.click(screen.getByRole("button", { name: "Wait" }));
    await waitFor(() =>
      expect(
        screen.getByText("The response is waiting. The queued message was not sent."),
      ).toBeVisible(),
    );
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("clears a held queue after a successful manual send", async () => {
    const user = userEvent.setup();
    const sendTurn = vi.fn(async () => true);
    function Harness() {
      const [draft, setDraft] = useState("Hold this");
      const [view, setView] = useState(viewWithAttempt("streaming"));
      return (
        <>
          <ChatWorkspace
            controller={controllerFixture({
              activeView: view,
              pendingDraft: draft,
              sendTurn,
              setPendingDraft: setDraft,
            })}
            providerSnapshot={providerSnapshot()}
          />
          <button onClick={() => setView(viewWithAttempt("cancelled"))} type="button">
            Cancel turn
          </button>
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    await user.click(screen.getByRole("button", { name: "Cancel turn" }));
    await waitFor(() =>
      expect(
        screen.getByText("The response was cancelled. The queued message was not sent."),
      ).toBeVisible(),
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sendTurn).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.queryByText("The response was cancelled. The queued message was not sent."),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows and decides one-time MCP tool approvals for the active thread", async () => {
    const user = userEvent.setup();
    const client = extensionClient();
    vi.mocked(client.listToolApprovals).mockResolvedValue([
      {
        approvalId: "44000000-0000-4000-8000-000000000010" as never,
        threadId: threadId as never,
        packageId: "44000000-0000-4000-8000-000000000012" as never,
        componentId: "server" as never,
        providerToolName: "plugin__server__read",
        mcpToolName: "read",
        inputJson: '{"path":"README.md"}',
        requestedAt: now as never,
      },
    ]);
    render(
      <ChatWorkspace
        controller={controllerFixture()}
        extensionClient={client}
        providerSnapshot={providerSnapshot()}
      />,
    );

    expect(await screen.findByRole("group", { name: "Extension tool approval" })).toHaveTextContent(
      "read",
    );
    expect(screen.getByText('{"path":"README.md"}')).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve once" }));
    expect(client.decideToolApproval).toHaveBeenCalledWith({
      approvalId: "44000000-0000-4000-8000-000000000010",
      decision: "approved",
    });
  });

  it("does not commit again when tool-approval polling returns the same data", async () => {
    const client = extensionClient();
    const approval = {
      approvalId: "44000000-0000-4000-8000-000000000010" as never,
      threadId: threadId as never,
      packageId: "44000000-0000-4000-8000-000000000012" as never,
      componentId: "server" as never,
      providerToolName: "plugin__server__read",
      mcpToolName: "read",
      inputJson: '{"path":"README.md"}',
      requestedAt: now as never,
    };
    vi.mocked(client.listToolApprovals).mockResolvedValue([approval]);
    const listToolApprovals = vi.mocked(client.listToolApprovals);
    const commits: Array<string> = [];

    render(
      <Profiler id="chat-workspace" onRender={(_, phase) => commits.push(phase)}>
        <ChatWorkspace
          controller={controllerFixture()}
          extensionClient={client}
          providerSnapshot={providerSnapshot()}
        />
      </Profiler>,
    );

    await screen.findByRole("group", { name: "Extension tool approval" });
    await waitFor(() => expect(listToolApprovals.mock.calls.length).toBeGreaterThan(2), {
      timeout: 2_500,
    });
    const commitsAfterPolling = commits.length;
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(commits.length).toBe(commitsAfterPolling);
  });

  it("windows the conversation so a long thread mounts a bounded number of turns", () => {
    const count = 1000;
    const turns = Array.from({ length: count }, (_, index) => {
      const n = String(index + 1).padStart(12, "0");
      return {
        id: `00000000-0000-4000-8000-${n}`,
        threadId,
        sequence: index + 1,
        userMessageRef: {
          contentId: `10000000-0000-4000-8000-${n}`,
          digest: "a".repeat(64),
          byteLength: 12,
        },
        attachmentIds: [],
        attempts: [
          {
            id: `30000000-0000-4000-8000-${n}`,
            turnId: `00000000-0000-4000-8000-${n}`,
            threadId,
            providerInstanceId: providerId,
            providerSessionId: "20000000-0000-4000-8000-000000000001",
            modelId: "model-a",
            contextManifestId: "30000000-0000-4000-8000-000000000001",
            outcome: "completed" as const,
            responseRefs: [
              {
                contentId: `20000000-0000-4000-8000-${n}`,
                digest: "b".repeat(64),
                byteLength: 12,
              },
            ],
            citationIds: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      };
    });
    const contents = turns.flatMap((turn, index) => [
      {
        contentId: String(turn.userMessageRef.contentId),
        role: "user" as const,
        body: `User turn ${String(index)}`,
        digest: "a".repeat(64),
        byteLength: 12,
      },
      {
        contentId: String(turn.attempts[0]!.responseRefs[0]!.contentId),
        role: "assistant" as const,
        body: `Assistant turn ${String(index)}`,
        digest: "b".repeat(64),
        byteLength: 16,
      },
    ]);
    const view = decodeChatThreadView({
      ...controllerFixture().activeView!,
      lastSequence: count,
      turns,
      contents,
    });
    render(
      <ChatWorkspace
        controller={controllerFixture({ activeView: view })}
        providerSnapshot={providerSnapshot()}
      />,
    );

    expect(document.querySelectorAll("[data-transcript-row]").length).toBeLessThan(80);
    expect(screen.getByText("User turn 0")).toBeVisible();
    expect(screen.queryByText("User turn 999")).not.toBeInTheDocument();
  });

  it("consumes an internal live extension selection after one successful send", async () => {
    const user = userEvent.setup();
    const client = extensionClient();
    const sendTurn = vi.fn(async () => true);
    function Harness() {
      const [draft, setDraft] = useState("");
      return (
        <ChatWorkspace
          controller={controllerFixture({
            pendingDraft: draft,
            sendTurn,
            setPendingDraft: setDraft,
          })}
          extensionClient={client}
          providerSnapshot={providerSnapshot()}
        />
      );
    }
    render(<Harness />);

    const composer = screen.getByRole("textbox", { name: "Message" });
    await user.type(composer, "@build-tools{Enter}");

    const receipt = await screen.findByRole("list", { name: "Selected extensions" });
    expect(receipt).toHaveTextContent("Build guidance");
    expect(receipt).toHaveTextContent("Selection verified");
    expect(sendTurn).not.toHaveBeenCalled();
    expect(composer).toHaveValue("");

    await user.type(composer, "Build the project{Enter}");
    await waitFor(() => expect(sendTurn).toHaveBeenCalledOnce());
    expect(sendTurn).toHaveBeenCalledWith(
      "Build the project",
      [],
      [],
      [],
      [expect.objectContaining({ kind: "plugin", componentId: "instructions" })],
      [],
    );
    expect(screen.queryByRole("list", { name: "Selected extensions" })).not.toBeInTheDocument();

    await user.clear(composer);
    await user.type(composer, "Continue without it{Enter}");
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2));
    expect(sendTurn).toHaveBeenLastCalledWith("Continue without it", [], [], [], [], []);
  });

  it("retains an internal extension selection when send fails so the user can retry", async () => {
    const user = userEvent.setup();
    const client = extensionClient();
    const sendTurn = vi.fn(async () => false);
    function Harness() {
      const [draft, setDraft] = useState("");
      return (
        <ChatWorkspace
          controller={controllerFixture({
            pendingDraft: draft,
            sendTurn,
            setPendingDraft: setDraft,
          })}
          extensionClient={client}
          providerSnapshot={providerSnapshot()}
        />
      );
    }
    render(<Harness />);

    const composer = screen.getByRole("textbox", { name: "Message" });
    await user.type(composer, "@build-tools{Enter}");
    await screen.findByRole("list", { name: "Selected extensions" });
    await user.type(composer, "Build the project{Enter}");

    await waitFor(() => expect(sendTurn).toHaveBeenCalledOnce());
    expect(sendTurn).toHaveBeenCalledWith(
      "Build the project",
      [],
      [],
      [],
      [expect.objectContaining({ kind: "plugin", componentId: "instructions" })],
      [],
    );
    expect(screen.getByRole("list", { name: "Selected extensions" })).toHaveTextContent(
      "Build guidance",
    );
  });

  it("clears internal receipts only when the authoritative provider family changes", async () => {
    const user = userEvent.setup();
    const client = extensionClient();
    const sendTurn = vi.fn(async () => true);
    function Harness(props: { readonly driverKind: "opencode" | "openai-compatible" }) {
      const [draft, setDraft] = useState("");
      return (
        <ChatWorkspace
          controller={controllerFixture({
            pendingDraft: draft,
            sendTurn,
            setPendingDraft: setDraft,
          })}
          extensionClient={client}
          providerSnapshot={providerSnapshot(props.driverKind)}
        />
      );
    }
    const { rerender } = render(<Harness driverKind="opencode" />);

    await user.type(screen.getByRole("textbox", { name: "Message" }), "@build-tools{Enter}");
    await screen.findByRole("list", { name: "Selected extensions" });

    rerender(<Harness driverKind="opencode" />);
    expect(screen.getByRole("list", { name: "Selected extensions" })).toBeVisible();

    rerender(<Harness driverKind="openai-compatible" />);
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Selected extensions" })).not.toBeInTheDocument(),
    );
  });

  it("keeps a missing exact structured reference visible instead of sending prompt text", async () => {
    const user = userEvent.setup();
    const client = extensionClient();
    const sendTurn = vi.fn(async () => true);
    function Harness() {
      const [draft, setDraft] = useState("");
      return (
        <ChatWorkspace
          controller={controllerFixture({
            pendingDraft: draft,
            sendTurn,
            setPendingDraft: setDraft,
          })}
          extensionClient={client}
          providerSnapshot={providerSnapshot()}
        />
      );
    }
    render(<Harness />);

    await user.type(screen.getByRole("textbox", { name: "Message" }), "@missing{Enter}");

    expect(await screen.findByRole("list", { name: "Selected extensions" })).toHaveTextContent(
      "Blocked: not-found",
    );
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous live plugin reference visible instead of choosing authority", async () => {
    const user = userEvent.setup();
    const client = extensionClient();
    const effective = await client.effectiveState({} as never);
    const originalPackage = effective.packages[0]!;
    vi.mocked(client.effectiveState).mockResolvedValue({
      ...effective,
      packages: [
        originalPackage,
        {
          ...originalPackage,
          extensionId: "30000000-0000-4000-8000-000000000002" as never,
          packageId: "31000000-0000-4000-8000-000000000002" as never,
        },
      ],
    });
    const sendTurn = vi.fn(async () => true);
    function Harness() {
      const [draft, setDraft] = useState("");
      return (
        <ChatWorkspace
          controller={controllerFixture({
            pendingDraft: draft,
            sendTurn,
            setPendingDraft: setDraft,
          })}
          extensionClient={client}
          providerSnapshot={providerSnapshot()}
        />
      );
    }
    render(<Harness />);

    await user.type(screen.getByRole("textbox", { name: "Message" }), "@build-tools{Enter}");

    expect(await screen.findByRole("list", { name: "Selected extensions" })).toHaveTextContent(
      "Blocked: ambiguous:",
    );
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("resolves an explicit skill reference through the same live draft path", async () => {
    const user = userEvent.setup();
    const client = extensionClient();
    const sendTurn = vi.fn(async () => true);
    function Harness() {
      const [draft, setDraft] = useState("");
      return (
        <ChatWorkspace
          controller={controllerFixture({
            pendingDraft: draft,
            sendTurn,
            setPendingDraft: setDraft,
          })}
          extensionClient={client}
          providerSnapshot={providerSnapshot()}
        />
      );
    }
    render(<Harness />);

    const composer = screen.getByRole("textbox", { name: "Message" });
    await user.type(composer, "$instructions{Enter}");

    expect(await screen.findByRole("list", { name: "Selected extensions" })).toHaveTextContent(
      "Build instructions",
    );
    await user.type(composer, "Review the build{Enter}");
    await waitFor(() => expect(sendTurn).toHaveBeenCalledOnce());
    expect(sendTurn).toHaveBeenCalledWith(
      "Review the build",
      [],
      [],
      [],
      [
        expect.objectContaining({
          kind: "skill",
          skillId: `catalog:octant~build-tools:instructions:sha256:${"a".repeat(64)}`,
        }),
      ],
      [],
    );
  });

  it("keeps email-like and ordinary text on the normal send path", async () => {
    const user = userEvent.setup();
    const client = extensionClient();
    const sendTurn = vi.fn(async () => true);
    function Harness() {
      const [draft, setDraft] = useState("");
      return (
        <ChatWorkspace
          controller={controllerFixture({
            pendingDraft: draft,
            sendTurn,
            setPendingDraft: setDraft,
          })}
          extensionClient={client}
          providerSnapshot={providerSnapshot()}
        />
      );
    }
    render(<Harness />);

    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Email dev@example.com{Enter}",
    );

    await waitFor(() => expect(sendTurn).toHaveBeenCalledOnce());
    expect(sendTurn).toHaveBeenCalledWith("Email dev@example.com", [], [], [], [], []);
    expect(client.snapshot).not.toHaveBeenCalled();
    expect(client.effectiveState).not.toHaveBeenCalled();
  });

  it("composes the calm thread header, work shelf, transcript, and authoritative composer", async () => {
    const user = userEvent.setup();
    const controller = controllerFixture();
    const extensionSelection = {
      kind: "plugin" as const,
      extensionId: "30000000-0000-4000-8000-000000000001" as never,
      packageId: "31000000-0000-4000-8000-000000000001" as never,
      componentId: "instructions" as never,
      packageVersion: "1.2.3" as never,
      packageDigest: `sha256:${"a".repeat(64)}` as never,
      catalogEpoch: `sha256:${"c".repeat(64)}` as never,
      origin: { kind: "draft" as const, reference: "draft-1" },
    };
    render(
      <ChatWorkspace
        controller={controller}
        pendingExtensionSelections={[
          {
            reference: "@build-tools",
            label: "Build guidance",
            selection: extensionSelection,
            status: { kind: "selected" },
          },
        ]}
        providerSnapshot={providerSnapshot()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Calm planning" })).toBeVisible();
    expect(screen.getByText("Work list · 1 remaining · 1 blocked")).toBeVisible();
    expect(screen.getByRole("button", { name: "Enable web research" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(document.body).not.toHaveTextContent(/repository|worktree|git status/i);
    expect(screen.getByRole("list", { name: "Selected extensions" })).toHaveTextContent(
      "Build guidance",
    );

    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(controller.sendTurn).toHaveBeenCalledWith(
      "Ship this plan",
      [],
      [],
      [],
      [extensionSelection],
      [],
    );
    expect(screen.getByRole("list", { name: "Selected extensions" })).toHaveTextContent(
      "Build guidance",
    );
    await user.click(screen.getByRole("button", { name: "Enable web research" }));
    expect(controller.execute).toHaveBeenCalledWith({
      kind: "change-chat-research",
      threadId: controller.activeView!.thread.id,
      expectedVersion: controller.activeView!.thread.version,
      researchEnabled: true,
      researchRouting: "automatic",
    } satisfies ChatCommand);
  });

  it("shows disconnected state without inventing a durable attempt outcome", () => {
    render(
      <ChatWorkspace
        controller={controllerFixture({ status: "disconnected", errorMessage: "Connection lost." })}
        providerSnapshot={providerSnapshot()}
      />,
    );

    expect(screen.getByText(/Disconnected — reconnecting/)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Connection lost.");
  });

  it("offers the selected model's declared options and issues change-chat-provider with the values", async () => {
    const user = userEvent.setup();
    const withOptions = providerSnapshotWithModelOptions();
    const controller = controllerFixture({}, { modelOptionValues: { "service-tier": "fast" } });
    const { rerender } = render(
      <ChatWorkspace controller={controller} providerSnapshot={withOptions} />,
    );

    // A non-default value must be visible while the panel is closed.
    expect(screen.getByRole("button", { name: "Model options" })).toHaveAttribute(
      "data-customized",
    );
    await user.click(screen.getByRole("button", { name: "Model options" }));
    expect(screen.getByRole("combobox", { name: "Speed" })).toHaveTextContent("Speed: fast");
    await user.click(screen.getByRole("combobox", { name: "Effort" }));
    await user.click(await screen.findByRole("option", { name: "Effort: high" }));
    expect(controller.execute).toHaveBeenCalledWith({
      kind: "change-chat-provider",
      threadId,
      expectedVersion: 3,
      providerInstanceId: providerId,
      modelId: "model-a",
      modelOptionValues: { "service-tier": "fast", effort: "high" },
    });

    await user.click(screen.getByRole("combobox", { name: "Speed" }));
    await user.click(await screen.findByRole("option", { name: "Speed: Default" }));
    expect(controller.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "change-chat-provider", modelOptionValues: {} }),
    );

    // A model that declares no options gets no option controls.
    const onModelB = controllerFixture({}, { modelId: "model-b" });
    rerender(<ChatWorkspace controller={onModelB} providerSnapshot={withOptions} />);
    expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Speed" })).toBeNull();
  });

  it("applies a second option change made before the first command's thread arrives", async () => {
    const user = userEvent.setup();
    const commands: ChatCommand[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstSettles = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const execute = vi.fn(async (command: ChatCommand) => {
      commands.push(command);
      const issued = commands.length;
      if (issued === 1) await firstSettles;
      return {
        kind: "thread-updated",
        thread: {
          id: threadId,
          version: 3 + issued,
          providerInstanceId: providerId,
          modelId: "model-a",
          modelOptionValues: (command as { readonly modelOptionValues?: Record<string, string> })
            .modelOptionValues,
        },
      } as never;
    });
    render(
      <ChatWorkspace
        controller={controllerFixture({ execute })}
        providerSnapshot={providerSnapshotWithModelOptions()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model options" }));
    await user.click(screen.getByRole("combobox", { name: "Effort" }));
    await user.click(await screen.findByRole("option", { name: "Effort: high" }));
    await user.click(screen.getByRole("combobox", { name: "Speed" }));
    await user.click(await screen.findByRole("option", { name: "Speed: fast" }));
    // The rendered thread is still at version 3: the second change waits for
    // the first command's authoritative thread instead of racing it.
    expect(commands).toHaveLength(1);

    releaseFirst();
    await waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[0]).toMatchObject({
      expectedVersion: 3,
      modelOptionValues: { effort: "high" },
    });
    expect(commands[1]).toMatchObject({
      expectedVersion: 4,
      modelOptionValues: { effort: "high", "service-tier": "fast" },
    });
  });

  it("toggles web research on the version an option change already in flight reached", async () => {
    const user = userEvent.setup();
    let releaseChange: () => void = () => undefined;
    const changeSettles = new Promise<void>((resolve) => {
      releaseChange = resolve;
    });
    const execute = vi.fn(async (command: { readonly kind: string }) => {
      if (command.kind === "change-chat-provider") await changeSettles;
      return {
        kind: "thread-updated",
        thread: {
          id: threadId,
          version: 4,
          providerInstanceId: providerId,
          modelId: "model-a",
          modelOptionValues: { effort: "high" },
        },
      } as never;
    });
    render(
      <ChatWorkspace
        controller={controllerFixture({ execute })}
        providerSnapshot={providerSnapshotWithModelOptions()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model options" }));
    await user.click(screen.getByRole("combobox", { name: "Effort" }));
    await user.click(await screen.findByRole("option", { name: "Effort: high" }));
    await user.click(screen.getByRole("button", { name: "Enable web research" }));

    // Both settings were requested, so both have to survive. Sending the
    // research toggle on the rendered version would race the option change and
    // whichever arrived second would be refused as stale, silently discarding
    // one of the two choices the person made.
    expect(execute).toHaveBeenCalledOnce();

    releaseChange();
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "change-chat-research", expectedVersion: 4 }),
    );
  });

  it("drops an option change made against the model a queued switch has already left", async () => {
    const user = userEvent.setup();
    const commands: ChatCommand[] = [];
    let releaseSwitch: () => void = () => undefined;
    const switchSettles = new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    });
    const execute = vi.fn(async (command: ChatCommand) => {
      commands.push(command);
      await switchSettles;
      return {
        kind: "thread-updated",
        thread: {
          id: threadId,
          version: 4,
          providerInstanceId: providerId,
          modelId: "model-b",
          modelOptionValues: {},
        },
      } as never;
    });
    render(
      <ChatWorkspace
        controller={controllerFixture({ execute })}
        providerSnapshot={providerSnapshotWithModelOptions()}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: "Model B" }));
    // The option controls still belong to model A: the switch has not settled,
    // so nothing has re-rendered them for model B yet.
    await user.click(screen.getByRole("button", { name: "Model options" }));
    await user.click(screen.getByRole("combobox", { name: "Effort" }));
    await user.click(await screen.findByRole("option", { name: "Effort: high" }));
    // A third command, queued behind both, marks where the queue has got to:
    // the dropped change cannot slip in after it.
    await user.click(screen.getByRole("button", { name: "Enable web research" }));

    releaseSwitch();
    await waitFor(() =>
      expect(commands.some((command) => command.kind === "change-chat-research")).toBe(true),
    );
    // An effort chosen for model A cannot be applied to model B, and applying it
    // as written would name model A and switch the thread back to it, undoing
    // the switch the person made first. So the stale change is dropped, and the
    // version it would have consumed is still there for the next command.
    expect(commands.map((command) => command.kind)).toEqual([
      "change-chat-provider",
      "change-chat-research",
    ]);
    expect(commands[0]).toMatchObject({ modelId: "model-b", expectedVersion: 3 });
    expect(commands[1]).toMatchObject({ expectedVersion: 4 });
  });

  it("sends a turn only after an option change already in flight has settled", async () => {
    const user = userEvent.setup();
    let releaseChange: () => void = () => undefined;
    const changeSettles = new Promise<void>((resolve) => {
      releaseChange = resolve;
    });
    const execute = vi.fn(async () => {
      await changeSettles;
      return {
        kind: "thread-updated",
        thread: {
          id: threadId,
          version: 4,
          providerInstanceId: providerId,
          modelId: "model-a",
          modelOptionValues: { effort: "high" },
        },
      } as never;
    });
    const sendTurn = vi.fn(async () => true);
    function Harness() {
      const [draft, setDraft] = useState("");
      return (
        <ChatWorkspace
          controller={controllerFixture({
            execute,
            pendingDraft: draft,
            sendTurn,
            setPendingDraft: setDraft,
          })}
          providerSnapshot={providerSnapshotWithModelOptions()}
        />
      );
    }
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Model options" }));
    await user.click(screen.getByRole("combobox", { name: "Effort" }));
    await user.click(await screen.findByRole("option", { name: "Effort: high" }));
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Think hard{Enter}");

    // The turn must run the setting the person just chose, so it waits for the
    // option command rather than racing it to the host.
    expect(execute).toHaveBeenCalledOnce();
    expect(sendTurn).not.toHaveBeenCalled();

    releaseChange();
    await waitFor(() => expect(sendTurn).toHaveBeenCalledOnce());
    // Waiting is not enough: the composer's closure still holds the version
    // from before the option change, so the send must carry the version that
    // change reached or the host refuses it as stale.
    expect(sendTurn).toHaveBeenCalledWith("Think hard", [], [], [], [], [], 4);
  });

  it("keeps unavailable provider and model selections visible and fail closed", () => {
    const snapshot = providerSnapshot();
    render(
      <ChatWorkspace
        controller={controllerFixture()}
        providerSnapshot={{
          ...snapshot,
          instances: [
            snapshot.instances[0]!,
            {
              ...snapshot.instances[0]!,
              id: "10000000-0000-4000-8000-000000000002" as never,
              displayName: "Ready provider",
            },
          ],
          observedStates: [
            {
              ...snapshot.observedStates[0]!,
              instanceId: "10000000-0000-4000-8000-000000000002" as never,
              models: [{ ...snapshot.observedStates[0]!.models[0]!, id: "model-b" as never }],
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveTextContent(
      "OpenCode (unavailable)",
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "model-a (unavailable)",
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(
      screen.getByText(/Choose an available provider and model before sending\./),
    ).toBeVisible();
  });

  it("blocks send while an attachment uploads and surfaces rejected files", async () => {
    const user = userEvent.setup();
    let finishUpload!: () => void;
    const upload = vi.fn<ChatController["upload"]>(
      () =>
        new Promise((resolve) => {
          finishUpload = () =>
            resolve({
              id: "00000000-0000-4000-8000-000000000923" as never,
              threadId: threadId as never,
              displayName: "diagram.png",
              mediaType: "image/png",
              byteLength: 5,
              digest: "a".repeat(64) as never,
              status: "finalized",
              createdAt: now as never,
            });
        }),
    );
    const controller = controllerFixture({ upload });
    render(<ChatWorkspace controller={controller} providerSnapshot={providerSnapshot()} />);

    const image = new File(["image"], "diagram.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Choose attachment file"), image);
    expect(screen.getByText("Uploading diagram.png.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    finishUpload();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    expect(screen.getByRole("list", { name: "Attached files" })).toHaveTextContent("diagram.png");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(controller.sendTurn).toHaveBeenCalledWith(
      "Ship this plan",
      [expect.any(String)],
      [],
      [],
      [],
      [],
    );
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Attached files" })).not.toBeInTheDocument(),
    );

    const secondImage = new File(["image"], "second.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Choose attachment file"), secondImage);
    finishUpload();
    await screen.findByText("second.png");
    await user.click(screen.getByRole("button", { name: "Remove second.png attachment" }));
    expect(controller.discard).toHaveBeenCalledWith({
      threadId: controller.activeView!.thread.id,
      attachmentId: expect.any(String),
    });
    await waitFor(() => expect(screen.queryByText("second.png")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(controller.sendTurn).toHaveBeenLastCalledWith("Ship this plan", [], [], [], [], []);

    const document = new File(["notes"], "notes.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("Choose attachment file"), document);
    expect(
      screen.getByText("notes.txt is unavailable to the selected provider and model."),
    ).toBeVisible();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(controller.sendTurn).toHaveBeenLastCalledWith("Ship this plan", [], [], [], [], []);

    const docx = new File(["document"], "proposal.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await user.upload(screen.getByLabelText("Choose attachment file"), docx);
    expect(
      screen.getByText("proposal.docx is unavailable to the selected provider and model."),
    ).toBeVisible();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("keeps send blocked until every image from one paste has uploaded", async () => {
    const user = userEvent.setup();
    const finishers: Array<() => void> = [];
    const upload = vi.fn<ChatController["upload"]>(
      (input) =>
        new Promise((resolve) => {
          finishers.push(() =>
            resolve({
              id: input.attachmentId,
              threadId: input.threadId,
              displayName: input.displayName,
              mediaType: input.mediaType as never,
              byteLength: input.bytes.byteLength,
              digest: "a".repeat(64) as never,
              status: "finalized",
              createdAt: now as never,
            }),
          );
        }),
    );
    const controller = controllerFixture({ upload });
    render(<ChatWorkspace controller={controller} providerSnapshot={providerSnapshot()} />);

    pasteImages(screen.getByLabelText("Message"), [
      new File(["first"], "first.png", { type: "image/png" }),
      new File(["second"], "second.png", { type: "image/png" }),
    ]);

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Uploading 2 attachments.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    // One image landing does not mean the paste is done. Re-enabling Send here
    // would let the second image arrive after the turn was sent and ride along
    // with the next message instead.
    finishers[0]?.();
    await screen.findByText("first.png");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByText("Uploading second.png.")).toBeVisible();

    finishers[1]?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(controller.sendTurn).toHaveBeenCalledWith(
      "Ship this plan",
      [expect.any(String), expect.any(String)],
      [],
      [],
      [],
      [],
    );
  });

  it("claims exactly the visible chips after an upload settles during a send", async () => {
    const user = userEvent.setup();
    const finishers: Array<() => void> = [];
    const upload = vi.fn<ChatController["upload"]>(
      (input) =>
        new Promise((resolve) => {
          finishers.push(() =>
            resolve({
              id: input.attachmentId,
              threadId: input.threadId,
              displayName: input.displayName,
              mediaType: input.mediaType as never,
              byteLength: input.bytes.byteLength,
              digest: "a".repeat(64) as never,
              status: "finalized",
              createdAt: now as never,
            }),
          );
        }),
    );
    let resolveSend!: (sent: boolean) => void;
    const sendTurn = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const controller = controllerFixture({ sendTurn, upload });
    render(<ChatWorkspace controller={controller} providerSnapshot={providerSnapshot()} />);

    await user.upload(
      screen.getByLabelText("Choose attachment file"),
      new File(["first"], "first.png", { type: "image/png" }),
    );
    finishers[0]!();
    await screen.findByText("first.png");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sendTurn).toHaveBeenCalledOnce());

    // A paste settles while the send is still awaited: its chip re-enters the
    // pending list from state that still contains the claimed attachment.
    await user.upload(
      screen.getByLabelText("Choose attachment file"),
      new File(["late"], "late.png", { type: "image/png" }),
    );
    finishers[1]!();
    await screen.findByText("late.png");

    resolveSend(true);
    // Only the claimed chip leaves; the mid-send arrival stays visible.
    await waitFor(() => expect(screen.queryByText("first.png")).not.toBeInTheDocument());
    expect(screen.getByText("late.png")).toBeInTheDocument();

    // The next send claims exactly the visible chip — no re-claimed sent
    // attachment, no invisible extra.
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2));
    const firstAttachmentId = upload.mock.calls[0]![0].attachmentId;
    const lateAttachmentId = upload.mock.calls[1]![0].attachmentId;
    expect(firstAttachmentId).not.toBe(lateAttachmentId);
    expect(sendTurn).toHaveBeenLastCalledWith("Ship this plan", [lateAttachmentId], [], [], [], []);
  });

  it("keeps an attachment visible when authoritative discard fails", async () => {
    const user = userEvent.setup();
    const controller = controllerFixture({
      upload: vi.fn(async (input) => ({
        id: input.attachmentId,
        threadId: input.threadId,
        displayName: input.displayName,
        mediaType: input.mediaType as never,
        byteLength: input.bytes.byteLength,
        digest: "a".repeat(64) as never,
        status: "finalized" as const,
        createdAt: now as never,
      })),
      discard: vi.fn(async () => {
        throw new Error("discard failed");
      }),
    });
    render(<ChatWorkspace controller={controller} providerSnapshot={providerSnapshot()} />);

    await user.upload(
      screen.getByLabelText("Choose attachment file"),
      new File(["image"], "keep.png", { type: "image/png" }),
    );
    await screen.findByText("keep.png");
    await user.click(screen.getByRole("button", { name: "Remove keep.png attachment" }));

    expect(await screen.findByText("keep.png could not be removed. Try again.")).toBeVisible();
    expect(screen.getByRole("list", { name: "Attached files" })).toHaveTextContent("keep.png");
  });

  it("discards unsent attachment bytes when the Chat tab unmounts", async () => {
    const user = userEvent.setup();
    const controller = controllerFixture({
      upload: vi.fn(async (input) => ({
        id: input.attachmentId,
        threadId: input.threadId,
        displayName: input.displayName,
        mediaType: input.mediaType as never,
        byteLength: input.bytes.byteLength,
        digest: "a".repeat(64) as never,
        status: "finalized" as const,
        createdAt: now as never,
      })),
    });
    const rendered = render(
      <ChatWorkspace controller={controller} providerSnapshot={providerSnapshot()} />,
    );
    await user.upload(
      screen.getByLabelText("Choose attachment file"),
      new File(["image"], "abandoned.png", { type: "image/png" }),
    );
    await screen.findByText("abandoned.png");

    rendered.unmount();

    expect(controller.discard).toHaveBeenCalledWith({
      threadId: controller.activeView!.thread.id,
      attachmentId: expect.any(String),
    });
  });

  it("discards an attachment whose upload finishes after the Chat tab unmounts", async () => {
    const user = userEvent.setup();
    let finishUpload!: (attachment: Awaited<ReturnType<ChatController["upload"]>>) => void;
    const upload = vi.fn<ChatController["upload"]>(
      (_input) =>
        new Promise((resolve) => {
          finishUpload = resolve;
        }),
    );
    const controller = controllerFixture({ upload });
    const rendered = render(
      <ChatWorkspace controller={controller} providerSnapshot={providerSnapshot()} />,
    );
    await user.upload(
      screen.getByLabelText("Choose attachment file"),
      new File(["image"], "late.png", { type: "image/png" }),
    );
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    const input = upload.mock.calls[0]![0];

    rendered.unmount();
    finishUpload({
      id: input.attachmentId,
      threadId: input.threadId,
      displayName: input.displayName,
      mediaType: input.mediaType as never,
      byteLength: input.bytes.byteLength,
      digest: "a".repeat(64) as never,
      status: "finalized",
      createdAt: now as never,
    });

    await waitFor(() =>
      expect(controller.discard).toHaveBeenCalledWith({
        threadId: input.threadId,
        attachmentId: input.attachmentId,
      }),
    );
  });

  it("does not discard attachments claimed by an in-flight send when the tab unmounts", async () => {
    const user = userEvent.setup();
    let resolveSend!: (sent: boolean) => void;
    const sendTurn = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const controller = controllerFixture({
      sendTurn,
      upload: vi.fn(async (input) => ({
        id: input.attachmentId,
        threadId: input.threadId,
        displayName: input.displayName,
        mediaType: input.mediaType as never,
        byteLength: input.bytes.byteLength,
        digest: "a".repeat(64) as never,
        status: "finalized" as const,
        createdAt: now as never,
      })),
    });
    const rendered = render(
      <ChatWorkspace controller={controller} providerSnapshot={providerSnapshot()} />,
    );
    await user.upload(
      screen.getByLabelText("Choose attachment file"),
      new File(["image"], "claimed.png", { type: "image/png" }),
    );
    await screen.findByText("claimed.png");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sendTurn).toHaveBeenCalledOnce());

    rendered.unmount();
    expect(controller.discard).not.toHaveBeenCalled();
    resolveSend(true);
    await Promise.resolve();
    expect(controller.discard).not.toHaveBeenCalled();
  });

  it("collapses copy, markdown, export, and canvas into one thread actions menu", async () => {
    const user = userEvent.setup();
    render(
      <ChatWorkspace
        canvasClient={{ threadReferenceCards: async () => ({ cards: [] }) } as never}
        controller={controllerFixture()}
        providerSnapshot={providerSnapshot()}
        serverUrl="http://127.0.0.1"
        windowCapability="window-capability"
      />,
    );

    // The header shows one trigger, not a row of always-visible controls.
    expect(screen.queryByRole("button", { name: "Copy Markdown" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export thread" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Canvas tools" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    expect(await screen.findByRole("menuitemradio", { name: "Copy conversation" })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: "Save as Markdown" })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: "Export…" })).toBeVisible();

    await user.click(screen.getByRole("menuitemradio", { name: "Show canvas" }));
    expect(await screen.findByRole("region", { name: "Canvas tools" })).toBeVisible();

    // The item reflects the open panel, and choosing it again closes the panel.
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Hide canvas" }));
    expect(screen.queryByRole("region", { name: "Canvas tools" })).toBeNull();
  });

  it("opens the linked-thread preview dialog when $review-in-parallel is resolved from the composer", async () => {
    const user = userEvent.setup();
    // A Response body can be read once, and this surface now makes more than
    // one request, so the mock builds a fresh reply per call rather than
    // handing every caller the same already-drained body.
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            kind: "linked-thread-preview-proposed",
            preview: {
              previewId: "66666666-6666-4666-8666-666666666666",
              requestId: "33333333-3333-4333-8333-333333333333",
              requestFingerprint: "a".repeat(64),
              prompt: "Review the migration plan.",
              matchedDirective: "/review 2 threads",
              sourceThreadId: threadId,
              sourceScope: {
                hostId: "local",
                mode: "chat",
                workspace: { kind: "chat-virtual", projectId: null },
              },
              sourceVersion: 3,
              contextSnapshotId: "44444444-4444-4444-8444-444444444444",
              targetScope: {
                hostId: "local",
                mode: "chat",
                workspace: { kind: "chat-virtual", projectId: null },
              },
              requestedCount: 2,
              threads: [
                {
                  targetIndex: 1,
                  label: "Reviewer 1",
                  prompt: "Review the migration plan.",
                  providerInstanceId: providerId,
                  modelId: "model-a",
                  effectiveAuthority: {
                    filesystem: false,
                    shell: false,
                    git: false,
                    network: false,
                    tools: false,
                    subagents: false,
                    executionPolicy: "plan",
                    permissionPersistence: "current-session",
                  },
                  fallbackCandidates: [],
                  capabilityDegradations: [],
                },
                {
                  targetIndex: 2,
                  label: "Reviewer 2",
                  prompt: "Review the migration plan.",
                  providerInstanceId: providerId,
                  modelId: "model-a",
                  effectiveAuthority: {
                    filesystem: false,
                    shell: false,
                    git: false,
                    network: false,
                    tools: false,
                    subagents: false,
                    executionPolicy: "plan",
                    permissionPersistence: "current-session",
                  },
                  fallbackCandidates: [],
                  capabilityDegradations: [],
                },
              ],
              requestedAuthority: {
                filesystem: false,
                shell: false,
                git: false,
                network: false,
                tools: false,
                subagents: false,
                executionPolicy: "plan",
                permissionPersistence: "current-session",
              },
              effectiveAuthority: {
                filesystem: false,
                shell: false,
                git: false,
                network: false,
                tools: false,
                subagents: false,
                executionPolicy: "plan",
                permissionPersistence: "current-session",
              },
              routingReceipt: {
                executionResolution: {
                  providerInstanceId: providerId,
                  modelId: "model-a",
                  hostId: "local",
                  executionPolicy: "plan",
                  permissionPersistence: "current-session",
                  effectivePermissions: {
                    filesystem: false,
                    shell: false,
                    git: false,
                    network: false,
                    tools: false,
                    subagents: false,
                  },
                  source: "project-default",
                  fallbackChain: ["project-default"],
                  downgradeReasons: [],
                },
                selectedProviderInstanceId: providerId,
                selectedModelId: "model-a",
                fallbackCandidates: [],
                capabilityDegradations: [],
                contextSnapshotId: "44444444-4444-4444-8444-444444444444",
                effectiveAuthorityDigest: "digest-1",
                hostId: "local",
                mode: "chat",
              },
              transferPolicy: {
                approvalsTransferred: false,
                credentialsTransferred: false,
                authorityTransferred: false,
                completionTransferred: false,
                activeHandlesTransferred: false,
                rootsTransferred: false,
                worktreesTransferred: false,
              },
              status: "proposed",
              nestingDepth: 1,
              proposedBy: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000001" },
              proposedAt: "2026-08-02T12:00:00.000Z",
              expiresAt: "2026-08-02T12:05:00.000Z",
              version: 1,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const setPendingDraft = vi.fn();
    function Harness() {
      const [draft, setDraft] = useState("");
      return (
        <ChatWorkspace
          controller={controllerFixture({
            pendingDraft: draft,
            setPendingDraft: (value) => {
              setDraft(value);
              setPendingDraft(value);
            },
          })}
          providerSnapshot={providerSnapshot()}
          serverUrl="http://127.0.0.1"
          windowCapability="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        />
      );
    }
    render(<Harness />);

    const composer = screen.getByRole("textbox", { name: "Message" });
    await user.type(composer, "$review-in-parallel Review the migration plan.{Enter}");

    expect(
      await screen.findByRole("dialog", { name: "Confirm parallel review" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/review-in-parallel/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1/api/linked-threads/commands",
      expect.objectContaining({ method: "POST" }),
    );
    expect(setPendingDraft).toHaveBeenCalledWith("");
    fetch.mockRestore();
  });

  it("narrows the Settings-defined pool through the composer control and persists it server-side", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => ({ kind: "thread-updated" }) as never);
    const controller = controllerFixture({ execute });
    render(<ChatWorkspace controller={controller} providerSnapshot={pooledProviderSnapshot()} />);

    await user.click(screen.getByRole("button", { name: "Model options" }));
    await user.click(screen.getByRole("button", { name: "Use multiple models" }));
    await user.click(screen.getByRole("checkbox", { name: "OpenCode — Model B" }));
    await user.click(screen.getByRole("button", { name: "Apply pool" }));

    expect(execute).toHaveBeenCalledWith({
      kind: "select-chat-multi-model-pool",
      threadId: threadId as never,
      expectedVersion: 3 as never,
      pool: {
        candidates: [
          { hostId: "local", providerInstanceId: providerId, modelId: "model-a" },
          { hostId: "local", providerInstanceId: providerId, modelId: "model-b" },
        ],
        mixedVendorEnabled: true,
        fallbackAllowed: true,
        higherCostFallbackAllowed: false,
      },
    });
  });

  it("restores the unchanged single-model flow from an active pool", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => ({ kind: "thread-updated" }) as never);
    const base = controllerFixture({ execute });
    const pooledView = decodeChatThreadView({
      ...base.activeView,
      thread: {
        ...base.activeView!.thread,
        multiModelPool: {
          candidates: [
            { hostId: "local", providerInstanceId: providerId, modelId: "model-a" },
            { hostId: "local", providerInstanceId: providerId, modelId: "model-b" },
          ],
          mixedVendorEnabled: true,
          fallbackAllowed: true,
          higherCostFallbackAllowed: false,
        },
      },
    });
    render(
      <ChatWorkspace
        controller={{ ...base, activeView: pooledView }}
        providerSnapshot={pooledProviderSnapshot()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model options" }));
    const trigger = screen.getByRole("button", { name: "Use multiple models" });
    expect(trigger).toHaveAttribute("aria-pressed", "true");
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Use single model" }));

    expect(execute).toHaveBeenCalledWith({
      kind: "select-chat-multi-model-pool",
      threadId: threadId as never,
      expectedVersion: 3 as never,
      pool: undefined,
    });
  });

  it("offers no multi-model pool when Settings define none", async () => {
    const user = userEvent.setup();
    render(
      <ChatWorkspace controller={controllerFixture()} providerSnapshot={providerSnapshot()} />,
    );
    await user.click(screen.getByRole("button", { name: "Model options" }));
    const trigger = screen.getByRole("button", { name: "Use multiple models" });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAccessibleDescription(/no agent-eligible models/i);
  });

  it("sends revise and branch commands against the version the user is looking at", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => undefined);
    const base = controllerFixture();
    const view = decodeChatThreadView({
      ...base.activeView!,
      turns: [
        {
          id: turnId,
          threadId,
          sequence: 1,
          userMessageRef: { contentId, digest: "a".repeat(64), byteLength: 12 },
          attachmentIds: [],
          attempts: [],
          createdAt: now,
        },
      ],
      contents: [
        {
          contentId,
          role: "user",
          body: "Ship the transcript first.",
          digest: "a".repeat(64),
          byteLength: 25,
        },
      ],
    });
    render(
      <ChatWorkspace
        controller={controllerFixture({ activeView: view, execute: execute as never })}
        providerSnapshot={providerSnapshot()}
      />,
    );

    await chooseTurnAction(user, "Branch from here");
    expect(execute).toHaveBeenCalledWith({
      kind: "branch-chat-thread",
      threadId: threadId as never,
      expectedVersion: 3 as never,
      turnId: turnId as never,
      title: "Calm planning (branch)",
    });

    await chooseTurnAction(user, "Edit");
    const editor = screen.getByRole("textbox", { name: "Edit your message" });
    await user.clear(editor);
    await user.type(editor, "Ship export first.");
    await user.click(screen.getByRole("button", { name: "Save and run" }));
    expect(execute).toHaveBeenCalledWith({
      kind: "edit-chat-turn",
      threadId: threadId as never,
      expectedVersion: 3 as never,
      turnId: turnId as never,
      prompt: "Ship export first.",
    });
  });

  it.each([
    {
      what: "revises a turn",
      act: async (user: ReturnType<typeof userEvent.setup>) => {
        await chooseTurnAction(user, "Edit");
        const editor = screen.getByRole("textbox", { name: "Edit your message" });
        await user.clear(editor);
        await user.type(editor, "Ship export first.");
        await user.click(screen.getByRole("button", { name: "Save and run" }));
      },
      expected: {
        kind: "edit-chat-turn",
        expectedVersion: 4,
        turnId,
        prompt: "Ship export first.",
      },
    },
    {
      what: "retries an attempt",
      act: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole("button", { name: "Retry failed response" }));
      },
      expected: { kind: "retry-chat-turn", expectedVersion: 4, turnId, attemptId },
    },
  ])("$what on the version an option change already in flight reached", async (scenario) => {
    const user = userEvent.setup();
    const commands: ChatCommand[] = [];
    let releaseChange: () => void = () => undefined;
    const changeSettles = new Promise<void>((resolve) => {
      releaseChange = resolve;
    });
    const execute = vi.fn(async (command: ChatCommand) => {
      commands.push(command);
      if (command.kind === "change-chat-provider") await changeSettles;
      return {
        kind: "thread-updated",
        thread: {
          id: threadId,
          version: 4,
          providerInstanceId: providerId,
          modelId: "model-a",
          modelOptionValues: { effort: "high" },
        },
      } as never;
    });
    render(
      <ChatWorkspace
        controller={controllerFixture({ activeView: viewWithFailedAttempt(), execute })}
        providerSnapshot={providerSnapshotWithModelOptions()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model options" }));
    await user.click(screen.getByRole("combobox", { name: "Effort" }));
    await user.click(await screen.findByRole("option", { name: "Effort: high" }));
    await scenario.act(user);

    // Sent on the rendered version, this would reach the host behind the option
    // change and be refused as stale — the person's revision or retry lost with
    // nothing to show for it. It waits for the option change instead.
    expect(commands.map((command) => command.kind)).toEqual(["change-chat-provider"]);

    releaseChange();
    await waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[1]).toMatchObject(scenario.expected);
  });

  it("hands the mention chip's Side Chat sidecar to the shell callback", async () => {
    const user = userEvent.setup();
    const sidecar = {
      sourceThreadId: "thread-1",
      sourceMode: "chat",
      sidecarThreadId: "00000000-0000-4000-8000-000000000201",
      title: "Side Chat about Release notes",
      createdAt: now,
    } as unknown as SideChatSidecar;
    const threadMentionClient = {
      search: vi.fn(async () => [
        {
          threadId: "thread-1",
          mode: "chat",
          title: "Release notes",
          placement: { kind: "project", label: "Launch" },
          updatedAt: now,
        },
      ]),
      resolve: vi.fn(async () => ({ mentions: [], unavailable: [] })),
      openSideChat: vi.fn(async () => ({ sidecar, created: true })),
      execute: vi.fn(),
    } as unknown as ThreadMentionClient;
    const onOpenSideChat = vi.fn();
    function Harness() {
      const [draft, setDraft] = useState("");
      return (
        <ChatWorkspace
          controller={controllerFixture({ pendingDraft: draft, setPendingDraft: setDraft })}
          onOpenSideChat={onOpenSideChat}
          providerSnapshot={providerSnapshot()}
          threadMentionClient={threadMentionClient}
        />
      );
    }
    render(<Harness />);

    await user.type(screen.getByRole("textbox", { name: "Message" }), "#Release");
    await user.click(await screen.findByRole("option", { name: /Release notes/ }));
    await user.click(screen.getByRole("button", { name: "Open Side Chat about Release notes" }));

    await waitFor(() => expect(onOpenSideChat).toHaveBeenCalledWith(sidecar));
    expect(threadMentionClient.openSideChat).toHaveBeenCalledWith(expect.any(String), "thread-1");
  });

  it("sends a `#thread` chip as an id and keeps the message to what the user typed", async () => {
    const user = userEvent.setup();
    const sendTurn = vi.fn(async () => true);
    const threadMentionClient = {
      search: vi.fn(async () => [
        {
          threadId: "thread-1",
          mode: "chat",
          title: "Release notes",
          placement: { kind: "project", label: "Launch" },
          updatedAt: now,
        },
      ]),
      resolve: vi.fn(async () => ({
        mentions: [
          {
            threadId: "thread-1",
            mode: "chat",
            title: "Release notes",
            placement: { kind: "project", label: "Launch" },
            transcript: [{ role: "user", text: "ship the notes", occurredAt: now }],
            truncated: false,
          },
        ],
        unavailable: [],
      })),
      openSideChat: vi.fn(),
      execute: vi.fn(),
    } as unknown as ThreadMentionClient;
    function Harness() {
      const [draft, setDraft] = useState("");
      return (
        <ChatWorkspace
          controller={controllerFixture({
            pendingDraft: draft,
            sendTurn,
            setPendingDraft: setDraft,
          })}
          providerSnapshot={providerSnapshot()}
          threadMentionClient={threadMentionClient}
        />
      );
    }
    render(<Harness />);

    const composer = screen.getByRole("textbox", { name: "Message" });
    await user.type(composer, "#Release");
    await user.click(await screen.findByRole("option", { name: /Release notes/ }));
    expect(
      screen.queryByRole("button", { name: "Open Side Chat about Release notes" }),
    ).not.toBeInTheDocument();
    await user.type(composer, "Compare these{Enter}");

    await waitFor(() => expect(sendTurn).toHaveBeenCalledOnce());
    // The chip travels as an id. The message the host stores — and the
    // transcript and export read back — is the user's own words, so nothing
    // the mention contributed can be replayed by a later turn.
    expect(sendTurn).toHaveBeenCalledWith(
      "#[Release notes] Compare these",
      [],
      [],
      [],
      [],
      ["thread-1"],
    );
  });

  it("opens the created branch thread and dispatches at most one branch at a time", async () => {
    const user = userEvent.setup();
    const base = controllerFixture();
    const view = decodeChatThreadView({
      ...base.activeView!,
      turns: [
        {
          id: turnId,
          threadId,
          sequence: 1,
          userMessageRef: { contentId, digest: "a".repeat(64), byteLength: 12 },
          attachmentIds: [],
          attempts: [],
          createdAt: now,
        },
      ],
      contents: [
        {
          contentId,
          role: "user",
          body: "Ship the transcript first.",
          digest: "a".repeat(64),
          byteLength: 25,
        },
      ],
    });
    const branchedThread = {
      ...view.thread,
      id: "00000000-0000-4000-8000-000000000933",
      title: "Calm planning (branch)",
    };
    let resolveBranch!: (result: unknown) => void;
    const execute = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveBranch = resolve;
        }),
    );
    const onThreadBranched = vi.fn();
    render(
      <ChatWorkspace
        controller={controllerFixture({ activeView: view, execute: execute as never })}
        onThreadBranched={onThreadBranched}
        providerSnapshot={providerSnapshot()}
      />,
    );

    await chooseTurnAction(user, "Branch from here");
    // While the server is still creating the branch, a second click must not
    // mint a second thread.
    await user.click(screen.getByRole("button", { name: "More actions" }));
    const branch = await screen.findByRole("menuitemradio", { name: "Branch from here" });
    expect(branch).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(branch);
    expect(execute).toHaveBeenCalledTimes(1);

    resolveBranch({ kind: "thread-created", thread: branchedThread });
    await waitFor(() => expect(onThreadBranched).toHaveBeenCalledWith(branchedThread));
    expect(onThreadBranched).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(
      await screen.findByRole("menuitemradio", { name: "Branch from here" }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  it("copies the conversation as Markdown and names what it could not include", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: { writeText } });
    render(
      <ChatWorkspace controller={controllerFixture()} providerSnapshot={providerSnapshot()} />,
    );

    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Copy conversation" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("# Calm planning"));
    expect(await screen.findByText(/Conversation copied as Markdown\./)).toBeVisible();
    vi.unstubAllGlobals();
  });

  it("says the copy failed when the window has no Clipboard API", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: undefined });
    render(
      <ChatWorkspace controller={controllerFixture()} providerSnapshot={providerSnapshot()} />,
    );

    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Copy conversation" }));
    expect(
      await screen.findByText("The conversation could not be copied to the clipboard."),
    ).toBeVisible();
    expect(screen.queryByText(/Conversation copied as Markdown\./)).toBeNull();
    vi.unstubAllGlobals();
  });

  it("does not show Create image until the provider snapshot is ready", () => {
    render(<ChatWorkspace controller={controllerFixture()} onOpenSettings={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Create image/ })).not.toBeInTheDocument();
  });

  it("does not show Create image when the image client is missing", () => {
    render(
      <ChatWorkspace
        controller={controllerFixture()}
        onOpenSettings={vi.fn()}
        providerSnapshot={providerSnapshot()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Create image/ })).not.toBeInTheDocument();
  });

  it("does not attach a generated image after the thread has changed", async () => {
    const user = userEvent.setup();
    let finishUpload!: () => void;
    const upload = vi.fn<ChatController["upload"]>(
      () =>
        new Promise((resolve) => {
          finishUpload = () =>
            resolve({
              id: "00000000-0000-4000-8000-000000000941" as never,
              threadId: threadId as never,
              displayName: "generated.png",
              mediaType: "image/png",
              byteLength: 5,
              digest: "a".repeat(64) as never,
              status: "finalized",
              createdAt: now as never,
            });
        }),
    );
    const discard = vi.fn(async (input) => ({
      id: input.attachmentId,
      threadId: input.threadId,
      displayName: "discarded",
      mediaType: "image/png" as const,
      byteLength: 0,
      digest: "a".repeat(64) as never,
      status: "purged" as const,
      createdAt: now as never,
    }));
    const jobId = "a3000000-0000-4000-8000-000000000003";
    const attachmentId = "a3000000-0000-4000-8000-000000000010";
    const { unmount } = render(
      <ChatWorkspace
        controller={controllerFixture({ upload, discard })}
        imageGenerationClient={
          {
            list: async () => ({
              jobs: [
                {
                  id: jobId,
                  status: "completed",
                  threadKind: "chat-thread",
                  scopeId: threadId,
                  profileInstanceId: providerId,
                  modelId: "gpt-image-2",
                  promptHash: "a".repeat(64),
                  artifacts: [
                    {
                      attachmentId,
                      hash: "b".repeat(64),
                      size: 5,
                      mime: "image/png",
                      evidence: {
                        profileInstanceId: providerId,
                        modelId: "gpt-image-2",
                        promptHash: "a".repeat(64),
                        jobId,
                      },
                    },
                  ],
                  version: 3,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            }),
            artifact: async () =>
              new Blob([Uint8Array.from([1, 2, 3, 4, 5])], { type: "image/png" }),
          } as never
        }
        providerSnapshot={providerSnapshot()}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Attach" }));
    await waitFor(() => expect(upload).toHaveBeenCalled());
    unmount();
    finishUpload();
    await Promise.resolve();
    expect(discard).toHaveBeenCalled();
  });
});

function pooledProviderSnapshot(): ProviderRegistrySnapshot {
  const base = providerSnapshot();
  const observed = base.observedStates[0]!;
  return {
    ...base,
    defaults: {
      ...base.defaults,
      agentEligibleModels: [
        { providerInstanceId: providerId as never, modelId: "model-a" as never },
        { providerInstanceId: providerId as never, modelId: "model-b" as never },
      ],
    },
    observedStates: [
      {
        ...observed,
        models: [
          ...observed.models,
          { ...observed.models[0]!, id: "model-b" as never, displayName: "Model B" },
        ],
      },
    ],
  } as ProviderRegistrySnapshot;
}

async function chooseTurnAction(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await user.click(await screen.findByRole("menuitemradio", { name }));
}
