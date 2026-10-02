import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantButton } from "./OctantButton";
import { OctantAlert } from "./OctantAlert";

describe("OctantAlert", () => {
  it("announces a warning with a title and keeps its action keyboard accessible", async () => {
    const retry = vi.fn();
    render(
      <OctantAlert
        action={
          <OctantButton onClick={retry} type="button">
            Retry
          </OctantButton>
        }
        title="Projections unavailable"
        tone="warning"
      >
        <p>Could not read the board.</p>
      </OctantAlert>,
    );

    expect(screen.getByRole("alert")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Projections unavailableCould not read the board.Retry",
    );
    screen.getByRole("button", { name: "Retry" }).focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(retry).toHaveBeenCalledOnce();
  });

  it("announces successful information without urgent alert semantics", () => {
    render(
      <OctantAlert tone="success">
        <p>Export is ready.</p>
      </OctantAlert>,
    );
    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "success");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
