import { OctantEmpty } from "./OctantEmpty";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("OctantEmpty states", () => {
  it("speaks for the whole window with a dotted mark, a title, one line and a text link back", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { container } = render(
      <OctantEmpty
        action={{ label: "Sign in again", onClick }}
        eyebrow="Browser session"
        message="Click Sign in again to refresh your session."
        layout="page"
        role="alert"
        state="warning"
        title="Your session expired"
      />,
    );

    const page = screen.getByRole("alert");
    expect(page).toHaveClass("shell-state--page");
    expect(screen.getByRole("heading", { name: "Your session expired" })).toBeVisible();
    expect(screen.getByText("Click Sign in again to refresh your session.")).toBeVisible();
    // The title says what happened; the eyebrow is left out.
    expect(screen.queryByText("Browser session")).toBeNull();
    expect(container.querySelector("svg.shell-state__mark")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders a compact named status without turning its icon into content", () => {
    const { container } = render(
      <OctantEmpty
        eyebrow="Workspace"
        message="Loading authoritative shell state."
        state="loading"
        title="Loading Octant"
      />,
    );

    expect(screen.getByRole("status")).toHaveAttribute("data-state", "loading");
    expect(screen.getByRole("status").querySelector('[data-slot="empty-title"]')).toHaveTextContent(
      "Loading Octant",
    );
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders a loading line as the title alone when no sentence is given", () => {
    const { container } = render(<OctantEmpty state="loading" title="Loading Files" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Files");
    expect(container.querySelector('[data-slot="empty-description"]')).toBeNull();
  });

  it("renders one raised, token-owned state card", () => {
    render(<OctantEmpty message="Try the primary action." role="status" title="Nothing here" />);

    const state = screen.getByRole("status");
    expect(state).toHaveAttribute("data-slot", "empty");
    expect(state).toHaveClass("rounded-xl");
    expect(state).toHaveClass("outline-(--oct-hairline)");
  });

  it("marks an unavailable state by its glyph and words, never by a warning colour", () => {
    render(
      <OctantEmpty
        eyebrow="Project authority"
        message="Local Machine access is unavailable."
        role="alert"
        state="warning"
        title="Project authority is unavailable"
      />,
    );

    // Plain messages stay neutral in every style. A brass triangle on a screen that says
    // something cannot be reached reads as an alarm, and the glyph and the title
    // already carry the meaning.
    const media = screen.getByRole("alert").querySelector('[data-slot="empty-media"]');
    expect(media).not.toHaveClass("text-[var(--octant-warning-text)]");
    expect(media?.querySelector("svg")).toBeInTheDocument();
  });

  it("keeps failure recovery visible and keyboard operable", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <OctantEmpty
        action={{ label: "Retry connection", onClick: onAction }}
        eyebrow="Connection"
        message="The local Octant server is unavailable."
        role="alert"
        state="disconnected"
        title="Octant is disconnected"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The local Octant server is unavailable.");
    expect(screen.getByRole("alert").querySelector('[data-slot="empty-media"]')).not.toHaveClass(
      "text-[var(--octant-warning-text)]",
    );
    await user.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});
