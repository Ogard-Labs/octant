// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorBoundsDialog } from "./CoordinatorBoundsDialog";

afterEach(cleanup);

describe("a running coordinator's limits", () => {
  it("shows the bounds in force, the defaults where the person set none", () => {
    render(
      <CoordinatorBoundsDialog
        bounds={{ rounds: 25 }}
        onClose={vi.fn()}
        onSave={vi.fn()}
        title="Backlog"
      />,
    );
    expect(screen.getByRole("dialog", { name: "Coordinator limits" })).toBeInTheDocument();
    expect(screen.getByText(/Backlog/)).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Wakes an hour" })).toHaveValue(30);
    expect(screen.getByRole("spinbutton", { name: "Rounds" })).toHaveValue(25);
    expect(screen.getByRole("spinbutton", { name: "Worker starts an hour" })).toHaveValue(60);
  });

  it("saves the bounds a person changed and leaves a bound at its default out", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <CoordinatorBoundsDialog
        bounds={{ rounds: 25 }}
        onClose={onClose}
        onSave={onSave}
        title="Backlog"
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Increase Wakes an hour" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ wakesPerHour: 31, rounds: 25 });

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
