import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantConfirmDialog } from "./OctantConfirmDialog";

describe("OctantConfirmDialog", () => {
  it("presents an ordinary confirmation without destructive emphasis and cancels by keyboard", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <OctantConfirmDialog
        confirmLabel="Continue"
        onCancel={onCancel}
        onConfirm={onConfirm}
        title="Continue?"
      >
        Continue with this action?
      </OctantConfirmDialog>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Continue?" });
    expect(dialog).toHaveAccessibleDescription("Continue with this action?");
    expect(screen.getByRole("button", { name: "Continue" })).toHaveAttribute(
      "data-variant",
      "default",
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await userEvent.setup().keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("emphasizes an explicit destructive action while keeping Cancel initially focused", async () => {
    render(
      <OctantConfirmDialog
        confirmLabel="Discard changes"
        destructive
        onCancel={() => undefined}
        onConfirm={() => undefined}
        title="Discard changes?"
      >
        Discard changes to a/very/long/path?
      </OctantConfirmDialog>,
    );

    expect(await screen.findByRole("button", { name: "Discard changes" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  });
});
