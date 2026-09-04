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
    expect(within(row("Changes")).getByText("Uncommitted changes")).toBeVisible();

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
    ["dirty", "Uncommitted changes"],
  ] as const)("says what a %s tree is without inventing counts", (changes, expected) => {
    renderGroup({ observation: { ...readyObservation, changes } });

    expect(within(row("Changes")).getByText(expected)).toBeVisible();
    expect(screen.queryByText(/[+\u2212]\d/)).not.toBeInTheDocument();
  });

  it("states how much a dirty tree changed once the host has measured it", () => {
    // "Uncommitted changes" says only that something is uncommitted; the totals
    // are what tell a reader whether that is a typo or a day's work.
    renderGroup({
      observation: { ...readyObservation, changes: "dirty", insertions: 2087, deletions: 621 },
    });

    const changes = within(row("Changes"));
    expect(changes.getByText(`+${(2087).toLocaleString()}`)).toBeVisible();
    expect(changes.getByText(`\u2212${(621).toLocaleString()}`)).toBeVisible();
  });

  it("keeps a clean tree clean even when the host reported zero counts", () => {
    renderGroup({
      observation: { ...readyObservation, changes: "clean", insertions: 0, deletions: 0 },
    });

    expect(within(row("Changes")).getByText("Clean working tree")).toBeVisible();
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
        action={{ label: "New task in this Project", onClick }}
        errorMessage="The Code thread checkout is unavailable."
        status="error"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The Code thread checkout is unavailable.");
    await userEvent.click(screen.getByRole("button", { name: "New task in this Project" }));

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
