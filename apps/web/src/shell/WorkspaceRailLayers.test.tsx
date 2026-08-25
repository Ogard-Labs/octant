import type { AutomationClient } from "@octant/client-runtime";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import {
  chats,
  chatShellBootstrap,
  client,
  codeShellBootstrap,
  codes,
  projectWindowCapability,
  projects,
  providers,
  providersWithToolModel,
  windowId,
  workProjectId,
  workProjects,
  workShellBootstrap,
  workThreadId,
} from "../App.test-fixtures";
import { decodeWorkThread } from "@octant/contracts";
import {
  automationCodeDraftFixture,
  automationDefinitionFixture,
  automationRunFixture,
  automationSummaryFixture,
} from "../automation/automationTestFixtures";
import { decodeCodeThreadId } from "@octant/contracts/code";

const codeThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000805");

const automationGate = vi.hoisted(() => ({ enabled: false }));
vi.mock("../automation/automationCenterGate", () => ({
  get AUTOMATION_CENTER_NAVIGATION_ENABLED() {
    return automationGate.enabled;
  },
}));

afterEach(() => {
  automationGate.enabled = false;
  vi.unstubAllGlobals();
});

describe("WorkspaceRailLayers", () => {
  it("keeps Automations hidden when that host capability is absent", async () => {
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    expect(
      await screen.findByRole("region", { name: "Workspace pane: Controller foundation" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pull requests" })).toBeVisible();
  });

  it("opens the Code pull-request workspace from the sidebar without refreshing GitHub", async () => {
    const user = userEvent.setup();
    const codeApi = codes();
    render(
      <App
        chatClient={chats()}
        codeClient={codeApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    expect(await screen.findByRole("button", { name: "Pull requests" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Pull requests" }));
    expect(await screen.findByRole("region", { name: "Pull requests" })).toBeVisible();
    expect(document.querySelector(".workspace")).toHaveAttribute("hidden");
    expect(codeApi.queryProjectPullRequests).toHaveBeenCalledWith({ version: 1 });
    expect(codeApi.refreshProjectPullRequests).not.toHaveBeenCalled();
  });

  it("opens the complete Automation Center from the sidebar once the release gate flips", async () => {
    automationGate.enabled = true;
    const user = userEvent.setup();
    const definition = automationDefinitionFixture(automationCodeDraftFixture());
    const run = automationRunFixture(definition, {
      lifecycle: "completed",
      threadId: String(codeThreadId),
    });
    const summary = automationSummaryFixture({
      id: definition.id,
      displayName: definition.displayName,
      mode: "code",
      projectId: definition.projectId,
      latestRunLifecycle: "completed",
    });
    const automationApi = {
      list: vi.fn(async () => ({ items: [summary] })),
      get: vi.fn(async () => ({ automation: definition, runs: [run] })),
      history: vi.fn(async () => ({ runs: [run] })),
      execute: vi.fn(),
    } as unknown as AutomationClient;
    const codeApi = codes();
    render(
      <App
        automationClient={automationApi}
        chatClient={chats()}
        codeClient={codeApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    // The thread names itself through the pane that holds it; the thread's own
    // body carries no title. CodeWorkspaceTab is also lazy, and its Suspense
    // fallback is a ShellState heading titled with the tab name, so a heading
    // probe would pass on the fallback before the chunk settled.
    await screen.findByRole("region", { name: "Workspace pane: Controller foundation" });
    expect(await screen.findByRole("region", { name: "Code thread" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Set your name" }));
    await user.click(await screen.findByRole("menuitem", { name: "Automations" }));

    expect(await screen.findByRole("heading", { name: "Automation Center" })).toBeVisible();
    expect(document.querySelector(".workspace")).toHaveAttribute("hidden");
    expect(await screen.findByRole("button", { name: "Nightly build check" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(screen.queryByRole("heading", { name: "Automation Center" })).not.toBeInTheDocument();
    expect(document.querySelector(".workspace")).not.toHaveAttribute("hidden");
    await user.click(screen.getByRole("button", { name: "Set your name" }));
    await user.click(await screen.findByRole("menuitem", { name: "Automations" }));

    await user.click(await screen.findByRole("button", { name: "Nightly build check" }));
    expect(await screen.findByRole("heading", { name: "Nightly build check" })).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "Open thread" }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Automation Center" })).not.toBeInTheDocument(),
    );
    expect(document.querySelector(".workspace")).not.toHaveAttribute("hidden");
    expect(
      await screen.findByRole("region", { name: "Workspace pane: Controller foundation" }),
    ).toBeVisible();
    expect(await screen.findByRole("region", { name: "Code thread" })).toBeVisible();
  });

  it("does not keep a GitHub placeholder overlay after the destination is absent", async () => {
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    expect(
      await screen.findByRole("region", { name: "Workspace pane: Controller foundation" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Pull requests" })).not.toBeInTheDocument();
    expect(document.querySelector(".rail-placeholder")).toBeNull();
    expect(document.querySelector(".workspace")).not.toHaveAttribute("hidden");
  });

  it("opens the Work Thread Board from the sidebar and activates the exact Project and thread", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/work/overview") || url.includes("/api/work/board")) {
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const queryBoard = vi.fn(async () => ({
      version: 1 as const,
      query: { version: 1 as const },
      cards: [
        {
          threadId: workThreadId,
          projectId: workProjectId,
          title: "Draft brief",
          status: "ready" as const,
          statusReason: "idle-unmet-delivery" as const,
          deliveryTarget: "Draft brief",
          deliverySatisfaction: "pending" as const,
          providerInstanceId: "90000000-0000-4000-8000-000000000001",
          modelId: "gpt-5",
          executing: false,
          binding: { kind: "bound" as const, workingDirectory: "." },
          activeRequest: { kind: "none" as const },
          artifacts: { count: 0 },
          citations: { count: 0, staleCount: 0 },
          goal: { kind: "none" as const },
          childRuns: { active: 0, completed: 0, failed: 0, unacknowledgedResults: 0 },
          pullRequestSummaries: { items: [], hiddenCount: 0 },
          recovery: { kind: "ok" as const },
          staleEvidence: false,
          followUp: false,
          lastMeaningfulActivityAt: null,
        },
      ],
      generatedAt: "2026-07-26T09:30:00.000Z",
    }));
    const workThreadClient = {
      bootstrap: vi.fn(async () => ({
        threads: [
          decodeWorkThread({
            id: workThreadId,
            projectId: workProjectId,
            title: "Draft brief",
            lifecycle: "active",
            providerInstanceId: "90000000-0000-4000-8000-000000000001",
            modelId: "gpt-5",
            bindingRevisionId: "30000000-0000-4000-8000-000000000001",
            workingDirectory: ".",
            version: 1,
            createdAt: "2026-07-26T09:30:00.000Z",
            updatedAt: "2026-07-26T09:30:00.000Z",
          }),
        ],
      })),
      execute: vi.fn(),
      queryBoard,
    };
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={workProjects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={client(workShellBootstrap())}
        workThreadClient={workThreadClient as never}
      />,
    );

    expect(await screen.findByRole("button", { name: "Thread board" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Thread board" }));
    expect(await screen.findByRole("region", { name: "Work Thread Board" })).toBeVisible();
    expect(queryBoard).toHaveBeenCalled();
    expect(document.querySelector(".workspace")).toHaveAttribute("hidden");

    const board = screen.getByRole("region", { name: "Work Thread Board" });
    await user.click(await within(board).findByRole("button", { name: "Draft brief" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Work Thread Board" })).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByRole("region", { name: "Workspace pane: Draft brief" }),
    ).toBeVisible();
  });

  it("does not offer a Thread board in Chat", async () => {
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(chatShellBootstrap())}
      />,
    );

    expect(await screen.findByRole("button", { name: "Workspace mode, Chat" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Thread board" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pull requests" })).not.toBeInTheDocument();
  });
});
