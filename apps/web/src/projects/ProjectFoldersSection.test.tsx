import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { ProjectRootPickerResult } from "@octant/contracts/desktop-bridge";
import { decodeProjectSummary, type ProjectSummary } from "@octant/contracts/projects";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectFoldersSection } from "./ProjectFoldersSection";

type BoundProjectSummary = Extract<ProjectSummary, { readonly type: "work" | "code" }>;

const RECEIPT = `${"R".repeat(42)}A`;
const ACTOR = { kind: "local-user", actorId: "81000000-0000-4000-8000-000000000001" } as const;

function project(
  extras: ReadonlyArray<string> = [],
  type: "work" | "code" = "work",
): BoundProjectSummary {
  const summary = decodeProjectSummary({
    id: "80000000-0000-4000-8000-000000000001",
    type,
    name: "Field notes",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 3,
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    binding: { canonicalRoot: "/Users/ada/Documents/Field notes" },
    bindingRevisionId: "80000000-0000-4000-8000-000000000002",
    ...(type === "code" ? { codeAccessPersistence: "current-session" } : {}),
    ...(extras.length === 0
      ? {}
      : {
          extraFolders: extras.map((canonicalRoot) => ({
            canonicalRoot,
            addedBy: ACTOR,
            addedAt: "2026-10-28T10:00:00.000Z",
          })),
        }),
  });
  if (summary.type === "chat") throw new Error("Expected a bound Project.");
  return summary;
}

function hostBridge(selection: ProjectRootPickerResult) {
  const selectProjectRoot = vi.fn(async (_projectType: "work" | "code") => selection);
  return { bridge: { selectProjectRoot }, selectProjectRoot };
}

const CHOSEN: ProjectRootPickerResult = {
  kind: "selected",
  receiptId: RECEIPT,
  displayName: "Research",
};

afterEach(cleanup);

describe("Project folders", () => {
  it("lists the main folder first and then each extra folder from home", () => {
    render(
      <ProjectFoldersSection
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        project={project(["/Users/ada/Dev/Research", "/Users/ada/Dev/Shared assets"])}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Main directory");
    expect(rows[0]).toHaveTextContent("~/Documents/Field notes");
    expect(rows[1]).toHaveTextContent("~/Dev/Research");
    expect(rows[2]).toHaveTextContent("~/Dev/Shared assets");
    expect(within(rows[1]!).getByTitle("/Users/ada/Dev/Research")).toBeVisible();
    expect(within(rows[1]!).getByText("/Users/ada/Dev/Research")).toHaveClass("sr-only");
  });

  it("names the main folder a repository for a Code Project", () => {
    render(
      <ProjectFoldersSection onAdd={vi.fn()} onRemove={vi.fn()} project={project([], "code")} />,
    );

    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Main repository");
  });

  it("says extra folders share the main folder's access while checkouts and Git stay in the main folder", () => {
    render(<ProjectFoldersSection onAdd={vi.fn()} onRemove={vi.fn()} project={project()} />);

    expect(
      screen.getByText(
        "Extra folders get the same access as the main folder. Checkouts and Git stay in the main folder; a terminal or a saved action can start in any of them.",
      ),
    ).toBeVisible();
  });

  it("adds the folder the native picker chose by handing its receipt to the Project", async () => {
    const picker = hostBridge(CHOSEN);
    const onAdd = vi.fn(async () => ({ status: "changed" as const }));
    render(
      <ProjectFoldersSection
        hostBridge={picker.bridge}
        onAdd={onAdd}
        onRemove={vi.fn()}
        project={project()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add folder…" }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(RECEIPT));
    expect(picker.selectProjectRoot).toHaveBeenCalledWith("work");
    expect(await screen.findByText("Folder added.")).toBeVisible();
  });

  it("asks the native picker for a directory in a Code Project too", async () => {
    const picker = hostBridge({ kind: "cancelled" });
    render(
      <ProjectFoldersSection
        hostBridge={picker.bridge}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        project={project([], "code")}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add folder…" }));

    expect(picker.selectProjectRoot).toHaveBeenCalledWith("code");
  });

  it("changes nothing when the person cancels the native picker", async () => {
    const picker = hostBridge({ kind: "cancelled" });
    const onAdd = vi.fn(async () => ({ status: "changed" as const }));
    render(
      <ProjectFoldersSection
        hostBridge={picker.bridge}
        onAdd={onAdd}
        onRemove={vi.fn()}
        project={project()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add folder…" }));

    await waitFor(() => expect(picker.selectProjectRoot).toHaveBeenCalledOnce());
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("removes an extra folder by its full path", async () => {
    const onRemove = vi.fn(async () => ({ status: "changed" as const }));
    render(
      <ProjectFoldersSection
        onAdd={vi.fn()}
        onRemove={onRemove}
        project={project(["/Users/ada/Dev/Research"])}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Remove /Users/ada/Dev/Research" }));

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("/Users/ada/Dev/Research"));
    expect(await screen.findByText("Folder removed.")).toBeVisible();
  });

  it("offers no way to remove the main folder", () => {
    render(<ProjectFoldersSection onAdd={vi.fn()} onRemove={vi.fn()} project={project()} />);

    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("shows the reason the host refused a folder and announces it as an alert", async () => {
    const picker = hostBridge(CHOSEN);
    const onAdd = vi.fn(async () => ({
      status: "refused" as const,
      message: "Your home folder cannot be added to a Project.",
    }));
    render(
      <ProjectFoldersSection
        hostBridge={picker.bridge}
        onAdd={onAdd}
        onRemove={vi.fn()}
        project={project()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add folder…" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your home folder cannot be added to a Project.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("closes the host folder browser and shows the refusal when the host refuses the folder it chose", async () => {
    const user = userEvent.setup();
    const browse = vi.fn(async () => ({
      breadcrumbs: [],
      candidates: [
        {
          candidateId: "80000000-0000-4000-8000-000000000020",
          displayName: "Home",
          isGitRepository: false,
          isSelectable: true,
        },
      ],
      hasMore: false,
      browsedAt: "2026-10-31T12:00:00.000Z",
    }));
    const select = vi.fn(async () => ({
      receiptId: RECEIPT,
      displayName: "Home",
      selectedAt: "2026-10-31T12:00:00.000Z",
    }));
    const onAdd = vi.fn(async () => ({
      status: "refused" as const,
      message: "Choose a folder inside your home folder, not the home folder itself.",
    }));
    render(
      <ProjectFoldersSection
        folderBrowseClient={{ browse, select } as unknown as FolderBrowseClient}
        hostId="80000000-0000-4000-8000-000000000099"
        onAdd={onAdd}
        onRemove={vi.fn()}
        project={project()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add folder…" }));
    await user.click(await screen.findByRole("button", { name: "Select" }));

    expect(onAdd).toHaveBeenCalledWith(RECEIPT);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a folder inside your home folder, not the home folder itself.",
    );
    // A second try opens a fresh browser that is not stuck selecting.
    await user.click(screen.getByRole("button", { name: "Add folder…" }));
    expect(await screen.findByRole("button", { name: "Select" })).toBeEnabled();
  });

  it("says folder selection is unavailable when this window has no picker", async () => {
    render(<ProjectFoldersSection onAdd={vi.fn()} onRemove={vi.fn()} project={project()} />);

    await userEvent.click(screen.getByRole("button", { name: "Add folder…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Folder selection is unavailable.");
  });

  it("lists the folders read-only for an archived or stale Project", () => {
    const { rerender } = render(
      <ProjectFoldersSection
        disabled
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        project={project(["/Users/ada/Dev/Research"])}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button")).toBeNull();

    rerender(<ProjectFoldersSection project={project(["/Users/ada/Dev/Research"])} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
