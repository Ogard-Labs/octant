import type { ProjectClient } from "@octant/client-runtime/project-client";
import {
  decodeMemoryEntryId,
  decodeProjectId,
  type ProjectId,
  type ProjectMemoryView,
  type ProjectSummary,
} from "@octant/contracts/projects";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectMemorySection } from "./ProjectMemorySection";
import { ProjectOverview } from "./ProjectOverview";

const alphaId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const betaId = decodeProjectId("00000000-0000-4000-8000-000000000902");
const archivedId = decodeProjectId("00000000-0000-4000-8000-000000000903");

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

function memoryView(
  projectId: ProjectId,
  content: string,
  historyContent?: string,
): ProjectMemoryView {
  return {
    projectId,
    active: [
      {
        id: decodeMemoryEntryId("00000000-0000-4000-8000-000000000911"),
        projectId,
        kind: "decision",
        content,
        provenance: { kind: "user-authored" },
        author: {
          kind: "local-user",
          actorId: "00000000-0000-4000-8000-000000000919" as never,
        },
        status: "active",
        version: 1 as never,
        createdAt: "2026-07-14T08:00:00.000Z" as never,
        updatedAt: "2026-07-14T08:00:00.000Z" as never,
      },
    ],
    history:
      historyContent === undefined
        ? []
        : [
            {
              id: decodeMemoryEntryId("00000000-0000-4000-8000-000000000912"),
              projectId,
              kind: "preference",
              content: historyContent,
              provenance: { kind: "user-authored" },
              author: {
                kind: "local-user",
                actorId: "00000000-0000-4000-8000-000000000919" as never,
              },
              status: "retracted",
              retractionReason: "Preference changed.",
              retractedBy: {
                kind: "local-user",
                actorId: "00000000-0000-4000-8000-000000000919" as never,
              },
              retractedAt: "2026-07-14T09:00:00.000Z" as never,
              version: 2 as never,
              createdAt: "2026-07-14T08:00:00.000Z" as never,
              updatedAt: "2026-07-14T09:00:00.000Z" as never,
            },
          ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function client(byProject: ReadonlyMap<string, ProjectMemoryView>): ProjectClient {
  return {
    bootstrap: vi.fn(),
    search: vi.fn(),
    executeProject: vi.fn(),
    executeMemory: vi.fn(),
    memory: vi.fn(async (projectId: ProjectId) => {
      const view = byProject.get(String(projectId));
      if (view === undefined) throw new Error("Missing memory.");
      return view;
    }),
    environment: vi.fn(),
  } as unknown as ProjectClient;
}

describe("Project memory in Project Overview", () => {
  it("exposes active entries, audited history, and mutations on the Overview", async () => {
    const alpha = project(alphaId, "Alpha");
    render(
      <ProjectOverview
        onArchive={vi.fn()}
        onRelink={vi.fn()}
        onRename={vi.fn()}
        project={alpha}
        projectClient={client(
          new Map([[String(alphaId), memoryView(alphaId, "Keep memory explicit.", "Old layout.")]]),
        )}
        memoryProjects={[alpha, project(betaId, "Beta")]}
      />,
    );

    const memory = await screen.findByRole("region", { name: "Project memory" });
    expect(memory).toHaveTextContent("Keep memory explicit.");
    expect(memory).toHaveTextContent("Old layout.");
    expect(memory).toHaveTextContent("Preference changed.");
    expect(screen.getByRole("button", { name: "Add memory" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Replace Keep memory explicit." })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retract Keep memory explicit." })).toBeVisible();
    expect(screen.getByRole("button", { name: "Transfer Keep memory explicit." })).toBeVisible();
  });

  it("does not show a previous Project's entries while another Overview loads", async () => {
    const pendingBeta = deferred<ProjectMemoryView>();
    const projectClient = {
      bootstrap: vi.fn(),
      search: vi.fn(),
      executeProject: vi.fn(),
      executeMemory: vi.fn(),
      memory: vi.fn((projectId: ProjectId) => {
        if (String(projectId) === String(betaId)) return pendingBeta.promise;
        return Promise.resolve(memoryView(alphaId, "Alpha remembers the roadmap."));
      }),
      environment: vi.fn(),
    } as unknown as ProjectClient;
    const alpha = project(alphaId, "Alpha");
    const beta = project(betaId, "Beta");
    const { rerender } = render(
      <ProjectMemorySection client={projectClient} project={alpha} projects={[alpha, beta]} />,
    );

    expect(await screen.findByText("Alpha remembers the roadmap.")).toBeVisible();

    rerender(
      <ProjectMemorySection client={projectClient} project={beta} projects={[alpha, beta]} />,
    );

    expect(screen.queryByText("Alpha remembers the roadmap.")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading Project memory");
    expect(screen.getByRole("button", { name: "Add memory" })).toBeDisabled();

    pendingBeta.resolve(memoryView(betaId, "Beta keeps its own facts."));
    expect(await screen.findByText("Beta keeps its own facts.")).toBeVisible();
    expect(screen.queryByText("Alpha remembers the roadmap.")).not.toBeInTheDocument();
  });

  it("keeps archived Project memory read-only", async () => {
    const archived = project(archivedId, "Archived", "archived");
    render(
      <ProjectMemorySection
        client={client(
          new Map([[String(archivedId), memoryView(archivedId, "Keep this decision.")]]),
        )}
        project={archived}
        projects={[archived]}
      />,
    );

    expect(await screen.findByText("Keep this decision.")).toBeVisible();
    expect(screen.getByText("Archived Project · memory is read-only")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add memory" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Replace / })).not.toBeInTheDocument(),
    );
  });
});
