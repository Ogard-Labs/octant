import type { CodeClient } from "@octant/client-runtime/code-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import { decodeProjectSummary } from "@octant/contracts/projects";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { RemoteAccessDefaults } from "./RemoteAccessDefaults";

const settings = {
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "current-session",
  version: 4,
  updatedAt: "2026-11-12T10:00:00.000Z",
} as const;

const workSettings = {
  defaultAccess: "ask-first",
  version: 7,
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

function clients() {
  const execute = vi.fn(async () => ({
    kind: "settings-updated" as const,
    settings: { ...settings, defaultExecutionPolicy: "full-access" as const, version: 5 },
  }));
  const executeProject = vi.fn(async () => ({}));
  const executeWork = vi.fn(async () => ({
    kind: "settings-updated" as const,
    settings: { ...workSettings, defaultAccess: "full-access" as const, version: 8 },
  }));
  return {
    execute,
    executeProject,
    executeWork,
    workThreadClient: {
      bootstrap: async () => ({ threads: [], runtime: [], settings: workSettings }),
      execute: executeWork,
    } as unknown as Pick<WorkThreadClient, "bootstrap" | "execute">,
    codeClient: {
      bootstrap: async () => ({ settings }),
      execute,
    } as unknown as Pick<CodeClient, "bootstrap" | "execute">,
    projectClient: {
      bootstrap: async () => ({ active: [project], archived: [], availability: [], memory: [] }),
      executeProject,
    } as unknown as ProjectClient,
  };
}

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("default modes on a browser the host's own person paired", () => {
  it("sets the default for new threads to Full access after the one-time warning, with no unlock step", async () => {
    const { codeClient, projectClient, workThreadClient, execute } = clients();
    const user = userEvent.setup();
    render(
      <RemoteAccessDefaults
        codeClient={codeClient}
        connected
        mode="code"
        projectClient={projectClient}
        workThreadClient={workThreadClient}
      />,
    );

    const picker = await screen.findByRole("combobox", { name: "Default mode for new threads" });
    expect(picker).toHaveTextContent("Ask first");
    await chooseSelectFieldOption(user, picker, "Full access");
    expect(execute).not.toHaveBeenCalled();
    await screen.findByRole("dialog", { name: "Use Full access?" });
    await user.click(screen.getByRole("button", { name: "Use Full access" }));

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith({
        kind: "update-code-settings",
        expectedVersion: 4,
        defaultExecutionPolicy: "full-access",
        defaultPermissionPersistence: "current-session",
        defaultAutoApprove: false,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Default mode for new threads" }),
      ).toHaveTextContent("Full access"),
    );
    expect(screen.queryByText(/unlock/i)).toBeNull();
  });

  it("sets a Project's default to Full access after that Project's one-time warning", async () => {
    const { codeClient, projectClient, workThreadClient, executeProject } = clients();
    const user = userEvent.setup();
    render(
      <RemoteAccessDefaults
        codeClient={codeClient}
        connected
        mode="code"
        projectClient={projectClient}
        workThreadClient={workThreadClient}
      />,
    );

    await screen.findByText("Notes");
    await chooseSelectFieldOption(
      user,
      screen.getByRole("combobox", { name: "Default mode for this Project" }),
      "Full access",
    );
    await screen.findByRole("dialog", { name: "Use Full access?" });
    await user.click(screen.getByRole("button", { name: "Use Full access" }));

    await waitFor(() =>
      expect(executeProject).toHaveBeenCalledWith({
        kind: "change-code-project-permission-mode",
        projectId: project.id,
        expectedVersion: 3,
        permissionMode: "full-access",
      }),
    );
  });

  it("sets Work's own default to Full access and offers Plan", async () => {
    const { codeClient, projectClient, workThreadClient, executeWork, execute } = clients();
    const user = userEvent.setup();
    render(
      <RemoteAccessDefaults
        codeClient={codeClient}
        connected
        mode="work"
        projectClient={projectClient}
        workThreadClient={workThreadClient}
      />,
    );

    const picker = await screen.findByRole("combobox", { name: "Default mode for new threads" });
    await waitFor(() => expect(picker).toHaveTextContent("Ask first"));
    await user.click(picker);
    expect(await screen.findByRole("option", { name: "Plan" })).toBeVisible();
    await user.click(await screen.findByRole("option", { name: "Full access" }));
    await user.click(await screen.findByRole("button", { name: "Use Full access" }));

    await waitFor(() =>
      expect(executeWork).toHaveBeenCalledWith({
        kind: "update-work-settings",
        expectedVersion: 7,
        defaultAccess: "full-access",
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("holds its controls while the session is stale, when the host would not hear a change", async () => {
    const { codeClient, projectClient, workThreadClient } = clients();
    render(
      <RemoteAccessDefaults
        codeClient={codeClient}
        connected={false}
        mode="code"
        projectClient={projectClient}
        workThreadClient={workThreadClient}
      />,
    );

    expect(
      await screen.findByRole("combobox", { name: "Default mode for new threads" }),
    ).toBeDisabled();
  });

  it("offers a Code Project the standing-permission switches a window offers, and sends each as a Project command", async () => {
    const { codeClient, projectClient, workThreadClient, executeProject } = clients();
    const user = userEvent.setup();
    render(
      <RemoteAccessDefaults
        codeClient={codeClient}
        connected
        mode="code"
        projectClient={projectClient}
        workThreadClient={workThreadClient}
      />,
    );

    await user.click(await screen.findByRole("switch", { name: "Agents may merge" }));
    await waitFor(() =>
      expect(executeProject).toHaveBeenCalledWith({
        kind: "change-code-project-agent-merge",
        projectId: project.id,
        expectedVersion: 3,
        agentMerge: "enabled",
      }),
    );
    for (const name of [
      "Agents may write Project memory without asking",
      "Agents may comment on pull requests",
      "Use the Project's own toolchain",
    ]) {
      expect(screen.getByRole("switch", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("switch", { name: /default branch/i })).toBeNull();
  });

  it("holds a Project's other switches until the first change comes back", async () => {
    const { codeClient, projectClient, workThreadClient, executeProject } = clients();
    executeProject.mockImplementation(() => new Promise(() => undefined));
    const user = userEvent.setup();
    render(
      <RemoteAccessDefaults
        codeClient={codeClient}
        connected
        mode="code"
        projectClient={projectClient}
        workThreadClient={workThreadClient}
      />,
    );

    await user.click(await screen.findByRole("switch", { name: "Agents may merge" }));
    await user.click(screen.getByRole("switch", { name: "Agents may comment on pull requests" }));

    expect(executeProject).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("switch", { name: "Agents may comment on pull requests" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("holds the standing-permission switches while the session is stale", async () => {
    const { codeClient, projectClient, workThreadClient } = clients();
    render(
      <RemoteAccessDefaults
        codeClient={codeClient}
        connected={false}
        mode="code"
        projectClient={projectClient}
        workThreadClient={workThreadClient}
      />,
    );

    expect(await screen.findByRole("switch", { name: "Agents may merge" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
