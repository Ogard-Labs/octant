import {
  decodeMemoryEntryId,
  decodeProjectId,
  type ActiveMemoryEntry,
  type MemoryEntryId,
  type ProjectId,
  type ProjectMemoryView,
  type ProjectSummary,
} from "@octant/contracts/projects";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { ProjectMemoryInspector } from "./ProjectMemoryInspector";

const sourceProjectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const destinationProjectId = decodeProjectId("00000000-0000-4000-8000-000000000902");
const archivedProjectId = decodeProjectId("00000000-0000-4000-8000-000000000903");
const decisionId = decodeMemoryEntryId("00000000-0000-4000-8000-000000000911");
const factId = decodeMemoryEntryId("00000000-0000-4000-8000-000000000912");

function project(
  id: ProjectId,
  name: string,
  lifecycle: "active" | "archived" = "active",
): ProjectSummary {
  return {
    id,
    type: "chat",
    name,
    lifecycle,
    pinned: false,
    rank: "0/1" as ProjectSummary["rank"],
    version: 1 as ProjectSummary["version"],
    createdAt: "2026-07-14T08:00:00.000Z" as ProjectSummary["createdAt"],
    updatedAt: "2026-07-14T08:00:00.000Z" as ProjectSummary["updatedAt"],
  };
}

function entry(
  id: MemoryEntryId,
  kind: ActiveMemoryEntry["kind"],
  content: string,
  overrides: Partial<ActiveMemoryEntry> = {},
): ActiveMemoryEntry {
  return {
    id,
    projectId: sourceProjectId,
    kind,
    content,
    provenance: { kind: "user-authored" },
    author: {
      kind: "local-user",
      actorId: "00000000-0000-4000-8000-000000000919" as never,
    },
    status: "active",
    version: 1 as ActiveMemoryEntry["version"],
    createdAt: "2026-07-14T08:00:00.000Z" as ActiveMemoryEntry["createdAt"],
    updatedAt: "2026-07-14T08:00:00.000Z" as ActiveMemoryEntry["updatedAt"],
    ...overrides,
  };
}

const memory: ProjectMemoryView = {
  projectId: sourceProjectId,
  active: [
    entry(decisionId, "decision", "Use explicit Project memory."),
    entry(factId, "fact", "The workspace remains local-first.", {
      provenance: {
        kind: "transferred",
        sourceProjectId: destinationProjectId,
        sourceEntryId: decodeMemoryEntryId("00000000-0000-4000-8000-000000000913"),
        destinationProjectId: sourceProjectId,
        transferredBy: {
          kind: "local-user",
          actorId: "00000000-0000-4000-8000-000000000918" as never,
        },
        transferredAt: "2026-07-14T08:30:00.000Z" as never,
        selectedContent: "The workspace remains local-first.",
      },
    }),
  ],
  history: [
    {
      ...entry(
        decodeMemoryEntryId("00000000-0000-4000-8000-000000000914"),
        "preference",
        "Use the former compact layout.",
        {
          author: {
            kind: "system",
            actorId: "00000000-0000-4000-8000-000000000917" as never,
          },
        },
      ),
      status: "retracted",
      retractionReason: "Preference changed.",
      retractedBy: {
        kind: "local-user",
        actorId: "00000000-0000-4000-8000-000000000919" as never,
      },
      retractedAt: "2026-07-14T09:00:00.000Z" as never,
      version: 2 as never,
    },
  ],
};

function renderInspector(
  overrides: Partial<React.ComponentProps<typeof ProjectMemoryInspector>> = {},
) {
  const props: React.ComponentProps<typeof ProjectMemoryInspector> = {
    project: project(sourceProjectId, "Source"),
    projects: [
      project(sourceProjectId, "Source"),
      project(destinationProjectId, "Destination"),
      project(archivedProjectId, "Archived", "archived"),
    ],
    memory,
    status: "ready",
    busy: false,
    onClose: vi.fn(),
    onLoad: vi.fn(async () => undefined),
    onCreate: vi.fn(async () => true),
    onSupersede: vi.fn(async () => true),
    onRetract: vi.fn(async () => true),
    onTransfer: vi.fn(async () => true),
    onRetry: vi.fn(async () => undefined),
    ...overrides,
  };
  return { props, ...render(<ProjectMemoryInspector {...props} />) };
}

describe("ProjectMemoryInspector", () => {
  it("embeds in Project Overview without a close control of its own", () => {
    renderInspector({ embedded: true });

    expect(screen.getByRole("heading", { name: "Memory" })).toBeVisible();
    // The page it sits on already names the Project; the embedded heading
    // is one section label among the others and repeats nothing.
    expect(screen.queryByText("Source")).not.toBeInTheDocument();
    expect(screen.queryByText("Project context")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close Project memory" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add memory" })).toBeVisible();
  });

  it("loads on disclosure and separates filterable active memory from audited history", async () => {
    const user = userEvent.setup();
    const { props } = renderInspector();

    expect(props.onLoad).toHaveBeenCalledWith(sourceProjectId);
    expect(screen.getByRole("complementary", { name: "Project memory" })).toBeVisible();
    expect(screen.getByText("Use explicit Project memory.")).toBeVisible();
    expect(screen.getByText("Use the former compact layout.")).toBeVisible();
    expect(screen.getByText("Preference changed.")).toBeVisible();
    expect(screen.getByText("Transfer provenance")).toBeVisible();
    expect(
      screen.getAllByText(/Original author: Local user · 00000000-0000-4000-8000-000000000919/),
    ).toHaveLength(2);
    expect(
      screen.getByText(/Original author: System · 00000000-0000-4000-8000-000000000917/),
    ).toBeVisible();
    expect(screen.getByText("Transfer actor").nextElementSibling).toHaveTextContent(
      "Local user · 00000000-0000-4000-8000-000000000918",
    );
    expect(screen.getByText("Source Project").nextElementSibling).toHaveTextContent(
      destinationProjectId,
    );
    expect(screen.getByText("Source entry").nextElementSibling).toHaveTextContent(
      "00000000-0000-4000-8000-000000000913",
    );
    expect(screen.getByText("Destination Project").nextElementSibling).toHaveTextContent(
      sourceProjectId,
    );
    expect(screen.getByText("Destination entry").nextElementSibling).toHaveTextContent(factId);
    expect(screen.getByText("Transferred at").nextElementSibling).toHaveTextContent(
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date("2026-07-14T08:30:00.000Z"),
      ),
    );
    expect(screen.getByText("Retraction actor").nextElementSibling).toHaveTextContent(
      "Local user · 00000000-0000-4000-8000-000000000919",
    );
    expect(
      screen
        .getByRole("complementary", { name: "Project memory" })
        .querySelector(".project-memory-scroll"),
    ).toBeInTheDocument();
    const updatedAt = screen
      .getByText("Use explicit Project memory.")
      .closest("article")
      ?.querySelector("time");
    expect(updatedAt).toHaveAttribute("datetime", "2026-07-14T08:00:00.000Z");
    expect(updatedAt).toHaveTextContent(
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date("2026-07-14T08:00:00.000Z"),
      ),
    );

    await chooseSelectFieldOption(user, screen.getByLabelText("Filter memory by kind"), "Fact");
    expect(screen.queryByText("Use explicit Project memory.")).not.toBeInTheDocument();
    expect(screen.getAllByText("The workspace remains local-first.")[0]).toBeVisible();
  });

  it("does not expose stale Project memory or mutations while another Project loads", () => {
    const destination = project(destinationProjectId, "Destination");
    const { props, rerender } = renderInspector();

    rerender(<ProjectMemoryInspector {...props} project={destination} status="ready" />);

    expect(screen.queryByText("Use explicit Project memory.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add memory" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Loading Project memory");
    expect(props.onLoad).toHaveBeenLastCalledWith(destinationProjectId);
  });

  it("requires explicit create, supersede, retract, and ID-only transfer workflows", async () => {
    const user = userEvent.setup();
    const { props } = renderInspector();

    await user.click(screen.getByRole("button", { name: "Add memory" }));
    const createDialog = screen.getByRole("dialog", { name: "Add Project memory" });
    await chooseSelectFieldOption(
      user,
      within(createDialog).getByLabelText("Memory kind"),
      "Outcome",
    );
    await user.type(within(createDialog).getByLabelText("Memory content"), "Renderer QA passed.");
    await user.click(within(createDialog).getByRole("button", { name: "Add memory" }));
    expect(props.onCreate).toHaveBeenCalledWith("outcome", "Renderer QA passed.");

    await user.click(screen.getByRole("button", { name: "Replace Use explicit Project memory." }));
    const replaceDialog = screen.getByRole("dialog", { name: "Replace Project memory" });
    await user.type(
      within(replaceDialog).getByLabelText("Replacement content"),
      "Keep Project memory explicit.",
    );
    await user.click(within(replaceDialog).getByRole("button", { name: "Replace memory" }));
    expect(props.onSupersede).toHaveBeenCalledWith(decisionId, "Keep Project memory explicit.");

    await user.click(screen.getByRole("button", { name: "Retract Use explicit Project memory." }));
    const retractDialog = screen.getByRole("dialog", { name: "Retract Project memory" });
    await user.type(within(retractDialog).getByLabelText("Retraction reason"), "Decision expired.");
    await user.click(within(retractDialog).getByRole("button", { name: "Confirm retraction" }));
    expect(props.onRetract).toHaveBeenCalledWith(decisionId, "Decision expired.");

    await user.click(screen.getByRole("button", { name: "Transfer Use explicit Project memory." }));
    const transferDialog = screen.getByRole("dialog", { name: "Transfer Project memory" });
    const destination = within(transferDialog).getByLabelText("Destination Project");
    await user.click(destination);
    expect(await screen.findByRole("option", { name: "Destination" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Archived" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Destination" }));
    await user.click(within(transferDialog).getByRole("button", { name: "Transfer memory" }));
    expect(props.onTransfer).toHaveBeenCalledWith(decisionId, destinationProjectId);
    const transferCall = vi.mocked(props.onTransfer).mock.calls[0]?.[0];
    expect(transferCall).toBe(decisionId);
    expect(vi.mocked(props.onTransfer).mock.calls[0]).not.toContain("Use explicit Project memory.");
  }, 15_000);

  it("shows honest load, retry, conflict, archived, and close states", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender, props } = renderInspector({
      status: "loading",
      onClose,
    });
    expect(screen.getByRole("status")).toHaveTextContent("Loading Project memory");

    rerender(
      <ProjectMemoryInspector
        {...props}
        errorMessage="Project memory is unavailable."
        status="error"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Project memory is unavailable.");
    await user.click(screen.getByRole("button", { name: "Retry memory" }));
    expect(props.onRetry).toHaveBeenCalledWith(sourceProjectId);

    rerender(<ProjectMemoryInspector {...props} memory={memory} status="conflict-reload" />);
    expect(screen.getByRole("status")).toHaveTextContent("Reloading authoritative memory");

    rerender(
      <ProjectMemoryInspector
        {...props}
        memory={memory}
        project={project(sourceProjectId, "Source", "archived")}
        status="ready"
      />,
    );
    expect(screen.getByText("Archived Project · memory is read-only")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add memory" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close Project memory" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stacks archived authority with loading, error, and conflict state in document order", () => {
    const archived = project(sourceProjectId, "Source", "archived");
    const { props, rerender } = renderInspector({ project: archived, status: "loading" });

    let stack = screen
      .getByRole("complementary", { name: "Project memory" })
      .querySelector(".project-memory-status-stack");
    expect(stack).toBeInTheDocument();
    expect(stack?.children).toHaveLength(2);
    expect(stack?.children[0]).toHaveTextContent("Archived Project · memory is read-only");
    expect(stack?.children[1]).toHaveAttribute("role", "status");
    expect(stack?.children[1]).toHaveTextContent("Loading Project memory");

    rerender(
      <ProjectMemoryInspector
        {...props}
        errorMessage="Project memory is unavailable."
        project={archived}
        status="error"
      />,
    );
    stack = screen
      .getByRole("complementary", { name: "Project memory" })
      .querySelector(".project-memory-status-stack");
    expect(stack?.children).toHaveLength(2);
    expect(stack?.children[0]).toHaveTextContent("Archived Project · memory is read-only");
    expect(stack?.children[1]).toHaveAttribute("role", "alert");

    rerender(<ProjectMemoryInspector {...props} project={archived} status="conflict-reload" />);
    stack = screen
      .getByRole("complementary", { name: "Project memory" })
      .querySelector(".project-memory-status-stack");
    expect(stack?.children).toHaveLength(2);
    expect(stack?.children[1]).toHaveAttribute("role", "status");
    expect(stack?.children[1]).toHaveTextContent("Reloading authoritative memory");
  });
});
