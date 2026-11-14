import type {
  OctantInstructionsResult,
  OctantInstructionsView,
} from "@octant/contracts/octant-instructions";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  INSTRUCTIONS_READ_ONLY_NOTE,
  INSTRUCTIONS_SECRET_WARNING,
  OctantInstructionsSettings,
  YOUR_INSTRUCTIONS_PURPOSE,
} from "./OctantInstructionsSettings";

function view(overrides: Partial<OctantInstructionsView> = {}): OctantInstructionsView {
  return {
    kind: "octant-instructions",
    instructions: "Use Work for research.",
    version: 3,
    canChange: true,
    ...overrides,
  };
}

function fakeClient(
  initial: OctantInstructionsView,
  answer: (instructions: string) => OctantInstructionsResult = (instructions) =>
    view({ instructions, version: 4 }),
) {
  const change = vi.fn(async (command: { readonly instructions: string }) =>
    answer(command.instructions),
  );
  return { change, client: { read: vi.fn(async () => initial), change } };
}

describe("Your instructions in Settings", () => {
  it("shows what the text is for, its count and limit, and saves the whole text against the version read", async () => {
    const user = userEvent.setup();
    const { client, change } = fakeClient(view());
    render(<OctantInstructionsSettings client={client} />);

    const field = await screen.findByRole("textbox", { name: "Your instructions" });
    expect(screen.getByText(YOUR_INSTRUCTIONS_PURPOSE)).toBeVisible();
    expect(screen.getByText("22 / 8,000 characters")).toBeVisible();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await user.clear(field);
    await user.type(field, "Plan in Code.");
    expect(screen.getByText("13 / 8,000 characters")).toBeVisible();
    await user.click(save);

    expect(change).toHaveBeenCalledWith({
      kind: "change-person-instructions",
      expectedVersion: 3,
      instructions: "Plan in Code.",
    });
    expect(await screen.findByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("refuses to save a text past its limit", async () => {
    const { client } = fakeClient(view({ instructions: "a".repeat(8_001) }));
    render(<OctantInstructionsSettings client={client} />);

    expect(await screen.findByText("8,001 / 8,000 characters")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Your instructions" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("warns when the text looks like it holds a key", async () => {
    const user = userEvent.setup();
    const { client } = fakeClient(view({ instructions: "" }));
    render(<OctantInstructionsSettings client={client} />);

    const field = await screen.findByRole("textbox", { name: "Your instructions" });
    expect(screen.queryByText(INSTRUCTIONS_SECRET_WARNING)).toBeNull();
    await user.type(field, "api_key=sk-live-1234");
    expect(screen.getByRole("alert")).toHaveTextContent(INSTRUCTIONS_SECRET_WARNING);
  });

  it("shows the text read-only, with no Save, where the window cannot change it", async () => {
    const { client } = fakeClient(view({ canChange: false }));
    render(<OctantInstructionsSettings client={client} />);

    const field = await screen.findByRole("textbox", { name: "Your instructions" });
    expect(field).toHaveAttribute("readonly");
    expect(field).toHaveValue("Use Work for research.");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText(INSTRUCTIONS_READ_ONLY_NOTE)).toBeVisible();
  });

  it("says why a save was refused and rereads the current text after a stale one", async () => {
    const user = userEvent.setup();
    const { client } = fakeClient(view(), () => ({
      kind: "octant-instructions-refused",
      reason: "stale-version",
      message: "Your instructions changed since you opened them. Reload and try again.",
    }));
    render(<OctantInstructionsSettings client={client} />);

    const field = await screen.findByRole("textbox", { name: "Your instructions" });
    await user.type(field, " Always.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("changed since you opened them");
    expect(client.read).toHaveBeenCalledTimes(2);
  });
});
