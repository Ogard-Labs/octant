import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import {
  decodeWorkThreadId,
  decodeWorkThreadBootstrap,
  decodeProjectId,
  decodeWorkspaceTab,
  decodeWorkspaceTabId,
  type ProjectSummary,
  type WorkspaceTab,
} from "@octant/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkThreadEnvironment } from "./WorkThreadEnvironment";

const projectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const threadId = decodeWorkThreadId("00000000-0000-4000-8000-000000000701");
const tabId = decodeWorkspaceTabId("30000000-0000-4000-8000-00000000000b");

function workTab(): Extract<WorkspaceTab, { readonly kind: "work-thread" }> {
  return decodeWorkspaceTab({
    kind: "work-thread",
    id: tabId,
    threadId,
    mode: "work",
    title: "Research brief",
  }) as Extract<WorkspaceTab, { readonly kind: "work-thread" }>;
}

function workProject(): ProjectSummary {
  return {
    id: projectId,
    type: "work",
    name: "Knowledge Base",
    lifecycle: "active",
    pinned: true,
    rank: "0/1" as ProjectSummary["rank"],
    version: 1 as ProjectSummary["version"],
    createdAt: "2026-07-16T08:00:00.000Z" as ProjectSummary["createdAt"],
    updatedAt: "2026-07-16T08:00:00.000Z" as ProjectSummary["updatedAt"],
    binding: { canonicalRoot: "/Users/example/Documents/work-root" },
    bindingRevisionId: "30000000-0000-4000-8000-000000000101" as never,
  } as ProjectSummary;
}

function threadClient(result: "ready" | "failed" = "ready"): WorkThreadClient {
  return {
    bootstrap:
      result === "ready"
        ? vi.fn(async () =>
            decodeWorkThreadBootstrap({
              threads: [
                {
                  id: threadId,
                  projectId,
                  title: "Research brief",
                  lifecycle: "active",
                  providerInstanceId: "00000000-0000-4000-8000-000000000902",
                  modelId: "gpt-4",
                  workingDirectory: ".",
                  version: 1,
                  createdAt: "2026-07-16T08:00:00.000Z",
                  updatedAt: "2026-07-16T08:00:00.000Z",
                },
              ],
            }),
          )
        : vi.fn(async () => Promise.reject(new Error("offline"))),
    navigation: vi.fn(async () => ({ threads: [], runtime: [] })),
    execute: vi.fn(),
    queryBoard: vi.fn(),
  };
}

async function openEnvironment(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Toggle environment" }));
}

describe("WorkThreadEnvironment", () => {
  it("renders the Work workspace inside a thread-scoped environment", async () => {
    render(
      <WorkThreadEnvironment
        projects={[workProject()]}
        tab={workTab()}
        threadClient={threadClient()}
      >
        <div data-testid="work-workspace-content">Work surface</div>
      </WorkThreadEnvironment>,
    );

    expect(screen.getByTestId("work-workspace-content")).toBeVisible();
    expect(await screen.findByRole("button", { name: "Toggle environment" })).toHaveAttribute(
      "data-environment-status",
      "available",
    );
    expect(screen.getByText(/Knowledge Base · work-root/)).toHaveClass("sr-only");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("fails closed when authoritative thread state cannot be loaded", async () => {
    render(
      <WorkThreadEnvironment
        projects={[workProject()]}
        tab={workTab()}
        threadClient={threadClient("failed")}
      >
        <div />
      </WorkThreadEnvironment>,
    );

    expect(await screen.findByRole("button", { name: "Toggle environment" })).toHaveAttribute(
      "data-environment-status",
      "unavailable",
    );
    expect(screen.getByText("Work · No folder Project")).toHaveClass("sr-only");
  });

  it("submits a bounded relative working directory through the focused Change working folder flow", async () => {
    const client = threadClient();
    const user = userEvent.setup();
    render(
      <WorkThreadEnvironment projects={[workProject()]} tab={workTab()} threadClient={client}>
        <div />
      </WorkThreadEnvironment>,
    );
    await openEnvironment();
    expect(screen.queryByLabelText("Working folder")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Working folder/ }));
    await user.click(screen.getByRole("button", { name: "Change working folder" }));
    const input = await screen.findByDisplayValue(".");
    await user.clear(input);
    await user.type(input, "research/brief");
    const apply = screen.getByRole("button", { name: "Apply working folder" });
    await waitFor(() => expect(apply).toBeEnabled(), { timeout: 5_000 });
    await user.click(apply);

    await waitFor(
      () =>
        expect(client.execute).toHaveBeenCalledWith({
          kind: "change-work-thread-working-directory",
          threadId,
          expectedVersion: 1,
          workingDirectory: "research/brief",
        }),
      { timeout: 5_000 },
    );
  });

  it("surfaces an authoritative Work working-directory rejection", async () => {
    const client = threadClient();
    vi.mocked(client.execute).mockResolvedValue({
      category: "invalid",
      message: "Work working directory is unavailable.",
    });
    render(
      <WorkThreadEnvironment projects={[workProject()]} tab={workTab()} threadClient={client}>
        <div />
      </WorkThreadEnvironment>,
    );
    await openEnvironment();
    fireEvent.click(screen.getByRole("button", { name: /^Working folder/ }));
    fireEvent.click(screen.getByRole("button", { name: "Change working folder" }));
    await screen.findByDisplayValue(".");
    fireEvent.change(screen.getByLabelText("Working folder"), {
      target: { value: "missing" },
    });
    screen.getByRole("button", { name: "Apply working folder" }).click();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose an existing folder inside this Project.",
    );
  });
});
