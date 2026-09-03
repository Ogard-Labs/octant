import { decodeProjectId, type CodeEnvironmentObservation } from "@octant/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentGitGroup } from "./EnvironmentGitGroup";

const projectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const observedAt = "2026-07-16T09:00:00.000Z" as CodeEnvironmentObservation["observedAt"];

const readyObservation: Extract<CodeEnvironmentObservation, { status: "ready" }> = {
  status: "ready",
  projectId,
  projectName: "Octant",
  observedAt,
  repositoryRoot: "/Users/example/Dev/Repos/octant",
  worktreeRoot:
    "/Users/example/Dev/Repos/octant/.agent-worktrees/issue-52-reference-faithful-shell",
  branch: { kind: "named", name: "feature/issue-52-reference-faithful-shell" },
  changes: "dirty",
};

function renderGroup(overrides: Partial<React.ComponentProps<typeof EnvironmentGitGroup>> = {}) {
  return render(
    <EnvironmentGitGroup observation={readyObservation} status="ready" {...overrides} />,
  );
}

function row(label: string): HTMLElement {
  return screen.getByText(label, { selector: "dt" }).parentElement!;
}

function expectRowOrder(): void {
  expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual([
    "Changes",
    "Branch",
    "Repository",
    "Worktree",
  ]);
}

describe("EnvironmentGitGroup", () => {
  it("maps a ready observation to truthful Git rows in fixed order", () => {
    renderGroup();

    expectRowOrder();
    expect(within(row("Changes")).getByText("Dirty working tree")).toBeVisible();

    const worktree = within(row("Worktree"));
    expect(worktree.getByText("issue-52-reference-faithful-shell")).toHaveClass(
      "environment-git-group__identity-primary",
    );
    expect(worktree.getByText(readyObservation.worktreeRoot)).toHaveClass(
      "environment-git-group__identity-secondary",
    );
    expect(worktree.getByTitle(readyObservation.worktreeRoot)).toBeVisible();

    expect(
      within(row("Branch")).getByText("feature/issue-52-reference-faithful-shell"),
    ).toBeVisible();

    const repository = within(row("Repository"));
    expect(repository.getByText("Octant")).toHaveClass("environment-git-group__identity-primary");
    expect(repository.getByText(readyObservation.repositoryRoot)).toHaveClass(
      "environment-git-group__identity-secondary",
    );
    expect(repository.getByTitle(readyObservation.repositoryRoot)).toBeVisible();
  });

  it.each([
    ["clean", "Clean working tree"],
    ["dirty", "Dirty working tree"],
  ] as const)("renders %s changes without invented counts", (changes, expected) => {
    renderGroup({ observation: { ...readyObservation, changes } });

    expect(within(row("Changes")).getByText(expected)).toBeVisible();
    expect(screen.queryByText(/\b\d+\s+(addition|deletion)s?\b/i)).not.toBeInTheDocument();
  });

  it("renders detached HEAD with a short display OID and discoverable full OID", () => {
    const oid = "0123456789abcdef0123456789abcdef01234567";
    renderGroup({ observation: { ...readyObservation, branch: { kind: "detached", oid } } });

    expectRowOrder();
    expect(within(row("Branch")).getByText("Detached HEAD")).toBeVisible();
    expect(within(row("Branch")).getByTitle(oid)).toHaveTextContent("0123456789ab");
    expect(within(row("Branch")).getByLabelText(`Full commit ${oid}`)).toBeInTheDocument();
  });

  it("shows one concise state while loading", () => {
    renderGroup({ observation: undefined, status: "loading" });

    expect(screen.getByRole("status")).toHaveTextContent("Loading repository environment");
    expect(screen.queryAllByRole("term")).toHaveLength(0);
  });

  it.each([
    ["unavailable", "Repository root is unavailable."],
    ["failed", "Git inspection failed."],
  ] as const)("renders a truthful %s observation", (status, reason) => {
    renderGroup({
      observation: {
        status,
        projectId,
        projectName: "Octant",
        observedAt,
        reason,
      },
    });

    expect(screen.getByText("Octant")).toBeVisible();
    expect(screen.queryAllByRole("term")).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent(reason);
  });

  it("announces transport errors without synthesizing Git identity", () => {
    renderGroup({
      errorMessage: "Project service unavailable.",
      observation: undefined,
      status: "error",
    });

    expect(screen.queryAllByRole("term")).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent("Project service unavailable.");
  });

  it("omits unsupported environment and Git operations", () => {
    renderGroup();

    for (const absent of [
      /Commit\/push/i,
      /Compare branch/i,
      /^Browser$/i,
      /^Sources$/i,
      /^Subagents$/i,
      /^Background processes$/i,
    ]) {
      expect(screen.queryByText(absent)).not.toBeInTheDocument();
    }
  });
});

describe("EnvironmentGitGroup way out", () => {
  it("offers a way forward when the checkout cannot be observed", async () => {
    const onClick = vi.fn();
    render(
      <EnvironmentGitGroup
        action={{ label: "New thread in this Project", onClick }}
        errorMessage="The Code thread checkout is unavailable."
        status="error"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The Code thread checkout is unavailable.");
    await userEvent.click(screen.getByRole("button", { name: "New thread in this Project" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("states the failure alone when the host offers nothing to press", () => {
    render(
      <EnvironmentGitGroup errorMessage="Repository environment is unavailable." status="error" />,
    );

    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
