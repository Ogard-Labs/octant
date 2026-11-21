// @vitest-environment jsdom
import type { CodeThreadId } from "@octant/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorDoneWhenButton } from "../code/CoordinatorWorkersPanel";
import { CoordinatorBoundsDialog } from "./CoordinatorBoundsDialog";

const WORKER_ID = "10000000-0000-4000-8000-000000000042" as CodeThreadId;

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
    expect(screen.getByRole("spinbutton", { name: "Check-ins an hour" })).toHaveValue(30);
    expect(screen.getByRole("spinbutton", { name: "Back-and-forths" })).toHaveValue(25);
    expect(screen.getByRole("spinbutton", { name: "New workers an hour" })).toHaveValue(60);
    // A running coordinator's workers' level is fixed; only the draft offers it.
    expect(screen.queryByRole("combobox", { name: "Workers start at" })).toBeNull();
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
    await user.click(screen.getByRole("button", { name: "Increase Check-ins an hour" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ wakesPerHour: 31, rounds: 25 });

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("lets a person view, add, remove, and clear coordinator done-when conditions alongside bounds", async () => {
    const onSaveDoneWhen = vi.fn();
    render(
      <CoordinatorBoundsDialog
        bounds={undefined}
        doneWhen={{
          value: {
            items: [
              {
                kind: "pull-request-checks-green",
                repositoryOwner: "Ogard-Labs",
                repositoryName: "octant",
                number: 10,
              },
            ],
          },
          threads: [{ id: WORKER_ID, title: "Fix login flow" }],
          defaultRepository: "Ogard-Labs/octant",
          onSave: onSaveDoneWhen,
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
        title="Release coordinator"
      />,
    );

    const user = userEvent.setup();
    // Existing condition is shown.
    expect(
      screen.getByText("Pull request Ogard-Labs/octant#10 required checks are green"),
    ).toBeInTheDocument();

    // Add a pull-request-merged condition using the pre-filled Project repository.
    await user.type(screen.getByRole("textbox", { name: "Pull request number" }), "42");
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    expect(screen.getByText("Pull request Ogard-Labs/octant#42 is merged")).toBeInTheDocument();

    // Remove the existing item and save.
    await user.click(
      screen.getByRole("button", {
        name: "Remove Pull request Ogard-Labs/octant#10 required checks are green",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSaveDoneWhen).toHaveBeenLastCalledWith(
      {},
      {
        items: [
          {
            kind: "pull-request-merged",
            repositoryOwner: "Ogard-Labs",
            repositoryName: "octant",
            number: 42,
          },
        ],
      },
    );

    // Clear all conditions and save undefined to clear on the host.
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByText("No done-when condition set.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSaveDoneWhen).toHaveBeenLastCalledWith({}, undefined);
  });

  it("renders the coordinator header Done when button with its active condition count", async () => {
    const onClick = vi.fn();
    render(<CoordinatorDoneWhenButton count={2} onClick={onClick} />);
    const button = screen.getByRole("button", { name: /Done when/ });
    expect(button).toHaveTextContent("Done when2");
    await userEvent.setup().click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("caps done-when items at 16 while keeping item controls and Save reachable", () => {
    const items = Array.from({ length: 16 }, (_, index) => ({
      kind: "pull-request-merged" as const,
      repositoryOwner: "Ogard-Labs",
      repositoryName: "octant",
      number: index + 1,
    }));
    render(
      <CoordinatorBoundsDialog
        bounds={undefined}
        doneWhen={{
          value: { items },
          threads: [],
          defaultRepository: "Ogard-Labs/octant",
          onSave: vi.fn(),
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
        title="Release coordinator"
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(16);
    expect(screen.getByRole("button", { name: "Add condition" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});
