import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeCheckoutBar } from "./CodeCheckoutBar";
import { CodeCheckoutProvider, type CodeCheckoutFacts } from "../environment/CodeCheckoutContext";

function facts(overrides: Partial<CodeCheckoutFacts> = {}): CodeCheckoutFacts {
  return {
    status: "ready",
    projectId: "10000000-0000-4000-8000-000000000001",
    projectName: "octant",
    repositoryRoot: "/Users/henrik/Dev/Repos/octant",
    worktreeRoot: "/Users/henrik/Dev/Repos/octant",
    branch: { kind: "named", name: "fix/shell-polish" },
    changes: "dirty",
    observedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  } as CodeCheckoutFacts;
}

describe("CodeCheckoutBar", () => {
  it("says nothing at all until a checkout has been observed", () => {
    const { container } = render(<CodeCheckoutBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the checkout the next message will be typed against", () => {
    render(
      <CodeCheckoutProvider observation={facts({ insertions: 1679, deletions: 378 })}>
        <CodeCheckoutBar />
      </CodeCheckoutProvider>,
    );

    expect(screen.getByText("octant")).toBeVisible();
    expect(screen.getByText("fix/shell-polish")).toBeVisible();
    expect(screen.getByText(`+${(1679).toLocaleString()}`)).toBeVisible();
    expect(screen.getByText(`−${(378).toLocaleString()}`)).toBeVisible();
  });

  it("shows no totals for a clean tree or one the host did not measure", () => {
    const { rerender } = render(
      <CodeCheckoutProvider observation={facts({ changes: "clean" })}>
        <CodeCheckoutBar />
      </CodeCheckoutProvider>,
    );
    expect(screen.queryByText(/[+−]\d/)).not.toBeInTheDocument();

    rerender(
      <CodeCheckoutProvider observation={facts()}>
        <CodeCheckoutBar />
      </CodeCheckoutProvider>,
    );
    expect(screen.queryByText(/[+−]\d/)).not.toBeInTheDocument();
  });

  it("offers the one action the branch and its diff lead to", async () => {
    const onCreatePullRequest = vi.fn();
    const user = userEvent.setup();
    render(
      <CodeCheckoutProvider observation={facts()}>
        <CodeCheckoutBar onCreatePullRequest={onCreatePullRequest} />
      </CodeCheckoutProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Create PR" }));
    expect(onCreatePullRequest).toHaveBeenCalledOnce();
  });

  it("hides the action rather than rendering a dead control", () => {
    render(
      <CodeCheckoutProvider observation={facts()}>
        <CodeCheckoutBar />
      </CodeCheckoutProvider>,
    );
    expect(screen.queryByRole("button", { name: "Create PR" })).not.toBeInTheDocument();
  });
});
