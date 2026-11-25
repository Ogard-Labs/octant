import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  SecretStoreBrowseResult,
  SecretStoreBrowseStep,
} from "@octant/contracts/secret-stores";
import { OnePasswordItemPicker } from "./OnePasswordItemPicker";

const listed = (
  entries: ReadonlyArray<{ id: string; label: string; reference?: string }>,
): SecretStoreBrowseResult => ({ status: "listed", entries, truncated: false });

function setup(
  browse: (step: SecretStoreBrowseStep) => Promise<SecretStoreBrowseResult> = async (step) =>
    step.kind === "vaults"
      ? listed([
          { id: "v", label: "Work" },
          { id: "p", label: "Private" },
        ])
      : step.kind === "items"
        ? listed([{ id: "i", label: "Deploy" }])
        : listed([{ id: "f", label: "credential", reference: "op://v/i/f" }]),
) {
  const onPick = vi.fn();
  const list = vi.fn(browse);
  render(<OnePasswordItemPicker label="Pick" disabled={false} browse={list} onPick={onPick} />);
  return { onPick, list };
}

describe("picking a 1Password item", () => {
  it("asks nothing until it is opened, then goes from vault to item to field", async () => {
    const { onPick, list } = setup();
    expect(list).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Pick" }));
    await userEvent.click(await screen.findByRole("button", { name: "Work" }));
    await userEvent.click(await screen.findByRole("button", { name: "Deploy" }));
    await userEvent.click(await screen.findByRole("button", { name: "credential" }));
    expect(list.mock.calls.map(([step]) => step)).toEqual([
      { kind: "vaults" },
      { kind: "items", vaultId: "v" },
      { kind: "fields", vaultId: "v", itemId: "i" },
    ]);
    expect(onPick).toHaveBeenCalledWith("op://v/i/f");
    await waitFor(() => expect(screen.queryByText("credential")).not.toBeInTheDocument());
  });

  it("filters by name and goes back a step", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Pick" }));
    await screen.findByRole("button", { name: "Work" });
    await userEvent.type(screen.getByLabelText("Filter Vaults"), "priv");
    expect(screen.queryByRole("button", { name: "Work" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Private" }));
    await screen.findByRole("button", { name: "Deploy" });
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "Work" })).toBeInTheDocument();
  });

  it.each([
    ["locked", /Unlock 1Password/],
    ["not-linked", /Link 1Password/],
    ["unavailable", /could not list/],
  ] as const)(
    "says what to do when the store answers %s, and tries again",
    async (status, text) => {
      let open = false;
      setup(async () => (open ? listed([{ id: "v", label: "Work" }]) : { status }));
      await userEvent.click(screen.getByRole("button", { name: "Pick" }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      open = true;
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("button", { name: "Work" })).toBeInTheDocument();
    },
  );
});
