import type { DesignSystemDocument } from "@octant/contracts/design-systems";
import type { ProjectSummary } from "@octant/contracts/projects";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectDesignSystemSection } from "./ProjectDesignSystemSection";

const root = "/tmp/acme";

const project = {
  id: "80000000-0000-4000-8000-000000000002",
  type: "code",
  name: "Acme",
  lifecycle: "active",
  pinned: false,
  rank: "0/1",
  version: 1,
  createdAt: "2026-07-14T10:00:00.000Z",
  updatedAt: "2026-07-14T10:00:00.000Z",
  binding: { canonicalRoot: root },
} as unknown as ProjectSummary;

function document(text: string, revision: string): DesignSystemDocument {
  return {
    folder: root,
    path: "DESIGN.md",
    text,
    revision,
    reading: {
      name: "Acme",
      frontMatter: "parsed",
      tokens: [
        {
          group: "color",
          key: "primary",
          token: "color-primary",
          value: "#1a73e8",
          status: "carried",
        },
        {
          group: "font",
          key: "body",
          token: "font-body",
          value: "Geist, sans-serif",
          status: "adjusted",
          carriedValue: "sans-serif",
          note: "Canvas draws sans-serif; it loads no web font for Geist",
        },
        {
          group: "font",
          key: "display",
          token: "font-display",
          value: "Brand Sans",
          status: "refused",
          note: "Canvas loads no web fonts",
        },
      ],
      brand: { "color-primary": "#1a73e8", "font-body": "sans-serif" },
      ignoredKeys: ["components"],
      sections: ["Colour", "Voice"],
      body: "",
    },
  };
}

function client(
  overrides: Partial<Parameters<typeof ProjectDesignSystemSection>[0]["client"]> = {},
) {
  return {
    listDesignSystems: vi.fn(async () => ({
      systems: [
        { folder: root, path: "DESIGN.md", name: "Acme", tokenCount: 2, primary: true },
        { folder: root, path: "apps/site/DESIGN.md", name: "Site", tokenCount: 0, primary: false },
      ],
      truncated: false,
    })),
    readDesignSystem: vi.fn(
      async (_projectId: string, location: { readonly folder: string; readonly path: string }) => ({
        ...document("# Acme\n", "r1"),
        ...location,
      }),
    ),
    saveDesignSystem: vi.fn(async () => ({
      status: "saved" as const,
      document: document("# Acme v2\n", "r2"),
    })),
    ...overrides,
  };
}

describe("ProjectDesignSystemSection", () => {
  it("lists the Project's design systems and draws the primary one's tokens and what Canvas leaves out", async () => {
    render(<ProjectDesignSystemSection client={client()} project={project} />);
    const list = await screen.findByRole("list", { name: "Design systems" });
    expect(within(list).getByRole("button", { name: "Acme" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(list).getByText("apps/site/DESIGN.md")).toBeInTheDocument();

    const colours = await screen.findByRole("list", { name: "Colour" });
    expect(within(colours).getByText("#1a73e8")).toBeInTheDocument();
    const type = screen.getByRole("list", { name: "Typography" });
    expect(within(type).getByText("sans-serif")).toBeInTheDocument();
    expect(within(type).getByText(/no web font for Geist/)).toBeInTheDocument();
    const left = screen.getByRole("list", { name: "Not used by Canvas" });
    expect(within(left).getByText("display")).toBeInTheDocument();
    expect(screen.getByText(/components/)).toBeInTheDocument();
  });

  it("swaps the Project to another design system, turns them off, and returns to the automatic rule", async () => {
    const onChoose = vi.fn(async () => true);
    render(<ProjectDesignSystemSection client={client()} onChoose={onChoose} project={project} />);
    expect(
      await screen.findByText(/follows Acme \(DESIGN\.md\), the top-level file/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Site" }));
    await userEvent.click(await screen.findByRole("button", { name: "Use for this Project" }));
    expect(onChoose).toHaveBeenLastCalledWith({
      kind: "file",
      folder: root,
      path: "apps/site/DESIGN.md",
    });
    await userEvent.click(screen.getByRole("button", { name: "Turn off design systems" }));
    expect(onChoose).toHaveBeenLastCalledWith({ kind: "none" });
  });

  it("says when the chosen design system is missing and offers the automatic rule back", async () => {
    const onChoose = vi.fn(async () => true);
    const fake = client({
      listDesignSystems: vi.fn(async () => ({
        systems: [{ folder: root, path: "DESIGN.md", name: "Acme", tokenCount: 2, primary: false }],
        truncated: false,
        choice: { kind: "file" as const, folder: root, path: "gone/DESIGN.md" },
        choiceMissing: true,
      })),
    });
    render(<ProjectDesignSystemSection client={fake} onChoose={onChoose} project={project} />);
    expect(await screen.findByText(/chosen gone\/DESIGN\.md is missing/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Follow the top-level file" }));
    expect(onChoose).toHaveBeenLastCalledWith(null);
  });

  it("saves an edit over the revision it was opened at", async () => {
    const fake = client();
    render(<ProjectDesignSystemSection client={fake} project={project} />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByLabelText("Edit DESIGN.md");
    await userEvent.clear(editor);
    await userEvent.type(editor, "# Acme v2");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(fake.saveDesignSystem).toHaveBeenCalledWith({
        projectId: project.id,
        folder: root,
        path: "DESIGN.md",
        text: "# Acme v2",
        baseRevision: "r1",
      }),
    );
  });

  it("keeps the draft and explains when the file changed on disk meanwhile", async () => {
    let onDisk = document("# Acme\n", "r1");
    const fake = client({
      readDesignSystem: vi.fn(
        async (
          _projectId: string,
          location: { readonly folder: string; readonly path: string },
        ) => ({
          ...onDisk,
          folder: location.folder,
          path: location.path,
        }),
      ),
      saveDesignSystem: vi.fn(async () => ({
        status: "refused" as const,
        reason: "stale" as const,
      })),
    });
    render(<ProjectDesignSystemSection client={fake} project={project} />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.type(screen.getByLabelText("Edit DESIGN.md"), "more");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/changed since you opened it/)).toBeInTheDocument();
    expect(screen.getByLabelText("Edit DESIGN.md")).toHaveValue("# Acme\nmore");

    // Reload takes the newer text and drops the old draft, so the next Save
    // cannot overwrite the change it was refused for.
    onDisk = document("# Acme, changed elsewhere\n", "r9");
    await userEvent.click(screen.getByRole("button", { name: "Reload from disk" }));
    expect(screen.queryByLabelText("Edit DESIGN.md")).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Edit DESIGN.md")).toHaveValue("# Acme, changed elsewhere\n");
  });

  it("creates a starter DESIGN.md at the top of a Project that has none", async () => {
    const saveDesignSystem = vi.fn(async (_request: { readonly text: string }) => ({
      status: "saved" as const,
      document: document("# Acme\n", "r1"),
    }));
    const fake = client({
      listDesignSystems: vi.fn(async () => ({ systems: [], truncated: false })),
      saveDesignSystem,
    });
    render(<ProjectDesignSystemSection client={fake} project={project} />);
    expect(await screen.findByText(/No DESIGN.md yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create DESIGN.md" }));
    await waitFor(() => expect(saveDesignSystem).toHaveBeenCalledOnce());
    const [request] = saveDesignSystem.mock.calls[0] ?? [];
    expect(request).toMatchObject({ folder: root, path: "DESIGN.md" });
    expect(request).not.toHaveProperty("baseRevision");
    expect(request?.text).toContain("colors:");
  });
});
