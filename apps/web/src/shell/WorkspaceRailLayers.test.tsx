import type { AutomationClient } from "@octant/client-runtime";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import {
  chats,
  client,
  codeShellBootstrap,
  codes,
  projectWindowCapability,
  projects,
  providers,
  windowId,
} from "../App.test-fixtures";
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
});

describe("WorkspaceRailLayers", () => {
  it("keeps Automations and GitHub destinations hidden when those host capabilities are absent", async () => {
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
    expect(screen.queryByRole("button", { name: "Pull requests" })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Automations" }));

    expect(await screen.findByRole("heading", { name: "Automation Center" })).toBeVisible();
    expect(document.querySelector(".workspace")).toHaveAttribute("hidden");
    expect(await screen.findByRole("button", { name: "Nightly build check" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(screen.queryByRole("heading", { name: "Automation Center" })).not.toBeInTheDocument();
    expect(document.querySelector(".workspace")).not.toHaveAttribute("hidden");
    await user.click(screen.getByRole("button", { name: "Automations" }));

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
});
