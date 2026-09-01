import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { OctantButton } from "../ui/base/OctantButton";
import { ContextInspector } from "./ContextInspector";
import { contextFixture, contextStaleFixture } from "./contextFixtures";

describe("ContextInspector", () => {
  it("shows limits, reserves, composition, accuracy, provenance, service freshness, and reconciliation", () => {
    render(
      <ContextInspector
        busy={false}
        onClose={vi.fn()}
        onRebuild={vi.fn()}
        onSetExcluded={vi.fn()}
        onSetPinned={vi.fn()}
        snapshot={contextFixture({ health: "watch" })}
      />,
    );
    const inspector = screen.getByRole("complementary", { name: "Context inspector" });
    expect(within(inspector).getByRole("heading", { name: "Context inspector" })).toBeVisible();
    expect(within(inspector).getByText("Safe input budget").nextElementSibling).toHaveTextContent(
      "900",
    );
    const planned = within(inspector).getByRole("region", { name: "Planned next turn" });
    expect(within(planned).getByText("Response reserve").nextElementSibling).toHaveTextContent(
      "50",
    );
    const composition = within(inspector).getByRole("region", { name: "Composition" });
    expect(within(composition).getByRole("heading", { name: "Current request" })).toBeVisible();
    expect(within(composition).getByText(/Exact tokenizer/)).toBeVisible();
    expect(within(composition).getByText(/Model-family estimate/)).toBeVisible();
    expect(within(inspector).getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(within(inspector).getByText("Latest sent")).toBeVisible();
    expect(within(inspector).getByText(/Actual input 104/)).toBeVisible();
    expect(within(inspector).getByText(/Request details hidden/)).toBeVisible();
  });

  it("never renders canonical source references or hidden sensitive values", () => {
    const secret = "SECRET-SOURCE-token=private";
    const { container } = render(
      <ContextInspector
        busy={false}
        onClose={vi.fn()}
        onRebuild={vi.fn()}
        onSetExcluded={vi.fn()}
        onSetPinned={vi.fn()}
        snapshot={contextFixture({ sourceReference: secret })}
      />,
    );
    expect(container.textContent).not.toContain(secret);
    expect(container.innerHTML).not.toContain(secret);
  });

  it("keeps protected controls disabled and emits only turn-scoped actions", async () => {
    const user = userEvent.setup();
    const onSetPinned = vi.fn();
    const onSetExcluded = vi.fn();
    const onRebuild = vi.fn();
    render(
      <ContextInspector
        busy={false}
        onClose={vi.fn()}
        onRebuild={onRebuild}
        onSetExcluded={onSetExcluded}
        onSetPinned={onSetPinned}
        snapshot={contextFixture()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Exclude Current request next turn" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Pin Repository search next turn" }));
    expect(onSetPinned).toHaveBeenCalledWith("50000000-0000-4000-8000-000000000002", true);
    await user.click(screen.getByRole("button", { name: "Exclude Repository search next turn" }));
    expect(onSetExcluded).toHaveBeenCalledWith("50000000-0000-4000-8000-000000000002", true);
    await user.click(screen.getByRole("button", { name: "Rebuild context plan" }));
    expect(onRebuild).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /send anyway/i })).not.toBeInTheDocument();
  });

  it("announces blocked remedies and disables commands while busy", () => {
    render(
      <ContextInspector
        busy
        onClose={vi.fn()}
        onRebuild={vi.fn()}
        onSetExcluded={vi.fn()}
        onSetPinned={vi.fn()}
        snapshot={contextFixture({ health: "blocked" })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Blocked");
    expect(screen.getByText("Exclude optional context")).toBeVisible();
    expect(screen.getByRole("button", { name: "Rebuild context plan" })).toBeDisabled();
  });

  it("returns focus to its opener on close", async () => {
    const user = userEvent.setup();
    const opener = createRef<HTMLButtonElement>();
    const onClose = vi.fn();
    render(
      <>
        <OctantButton ref={opener} type="button">
          Open inspector
        </OctantButton>
        <ContextInspector
          busy={false}
          onClose={onClose}
          onRebuild={vi.fn()}
          onSetExcluded={vi.fn()}
          onSetPinned={vi.fn()}
          restoreFocus={opener}
          snapshot={contextFixture()}
        />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Close context inspector" }));
    expect(onClose).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(opener.current).toHaveFocus());
  });

  it("renders the planned composition instead of stale manifest state", () => {
    render(
      <ContextInspector
        busy={false}
        onClose={vi.fn()}
        onRebuild={vi.fn()}
        onSetExcluded={vi.fn()}
        onSetPinned={vi.fn()}
        snapshot={contextFixture({ plannedReduction: true })}
      />,
    );
    const entry = screen.getByRole("article", { name: "Repository search" });
    expect(entry).toHaveAttribute("data-state", "truncated");
    expect(within(entry).getByText("21 · Conservative estimate")).toBeVisible();
    expect(within(entry).getByText("truncated", { selector: "dd" })).toBeVisible();
  });

  it("expands latest sent evidence and provider retry/reset state", () => {
    render(
      <ContextInspector
        busy={false}
        onClose={vi.fn()}
        onRebuild={vi.fn()}
        onSetExcluded={vi.fn()}
        onSetPinned={vi.fn()}
        snapshot={contextFixture({ health: "rate-limited", plannedReduction: true })}
      />,
    );
    const latest = screen.getByRole("region", { name: "Latest sent" });
    expect(within(latest).getByText("Manifest").nextElementSibling).toHaveTextContent(
      "30000000-0000-4000-8000-000000000001",
    );
    expect(within(latest).getByText("Response reserve").nextElementSibling).toHaveTextContent("50");
    const sentEntry = within(latest).getByRole("article", { name: "Sent Repository search" });
    expect(within(sentEntry).getByText("Repository search")).toBeVisible();
    expect(within(sentEntry).getAllByText("truncated")).toHaveLength(2);
    expect(within(sentEntry).getByText(/Conservative estimate/)).toBeVisible();
    expect(screen.getByText("Retry").nextElementSibling).toHaveTextContent("Active until");
    expect(screen.getByText("Concurrency reset").nextElementSibling).toHaveTextContent(
      "Jul 18, 2026",
    );
  });

  it("shows the authoritative provider update time without inventing freshness policy", () => {
    render(
      <ContextInspector
        busy={false}
        onClose={vi.fn()}
        onRebuild={vi.fn()}
        onSetExcluded={vi.fn()}
        onSetPinned={vi.fn()}
        snapshot={contextStaleFixture()}
      />,
    );
    expect(screen.getByText("Updated")).toBeVisible();
    expect(screen.getByText("Updated").nextElementSibling).toHaveAttribute(
      "datetime",
      "2026-07-18T20:00:00.000Z",
    );
    expect(screen.queryByText(/stale provider evidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/current provider evidence/i)).not.toBeInTheDocument();
  });
});
