import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RoutineComposer } from "./RoutineComposer";

const draftSchedule = ".routine-composer__draft-schedule";
const draftWork = ".routine-composer__draft-work";

function composer() {
  const onConfirm = vi.fn();
  render(<RoutineComposer now="2026-08-18T08:00:00.000Z" onConfirm={onConfirm} timeZone="UTC" />);
  return { onConfirm };
}

describe("asking for a routine in your own words", () => {
  it("shows what it understood before anything is created", async () => {
    const user = userEvent.setup();
    const { onConfirm } = composer();

    await user.type(
      screen.getByLabelText("What do you want automated?"),
      "Every weekday at 9:00, summarise what changed overnight",
    );

    expect(screen.getByText("Weekdays at 9:00", { selector: draftSchedule })).toBeVisible();
    expect(
      screen.getByText("summarise what changed overnight", { selector: draftWork }),
    ).toBeVisible();
    // Reading a request is not creating a routine.
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("hands the draft to the editor rather than saving it", async () => {
    const user = userEvent.setup();
    const { onConfirm } = composer();

    await user.type(screen.getByLabelText("What do you want automated?"), "Every hour, check CI");
    await user.click(screen.getByRole("button", { name: "Review this routine" }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({ needsSchedule: false });
  });

  it("says so, and still carries the work, when it cannot read a schedule", async () => {
    const user = userEvent.setup();
    composer();

    await user.type(
      screen.getByLabelText("What do you want automated?"),
      "Keep an eye on the deploy queue",
    );

    expect(screen.getByText(/Could not read a schedule/)).toBeVisible();
    expect(
      screen.getByText("Keep an eye on the deploy queue", { selector: draftWork }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Review and add a schedule" })).toBeVisible();
  });

  it("fills the request from a suggestion so the vocabulary is learnable", async () => {
    const user = userEvent.setup();
    composer();

    await user.click(screen.getByRole("button", { name: "Every hour" }));

    expect(screen.getByLabelText("What do you want automated?")).toHaveValue(
      "Every hour, check whether the test suite still passes",
    );
    expect(screen.getByText("Every hour", { selector: draftSchedule })).toBeVisible();
  });

  it("shows nothing until something is asked for", () => {
    composer();

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
