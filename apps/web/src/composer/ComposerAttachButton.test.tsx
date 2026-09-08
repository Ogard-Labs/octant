import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposerAttachButton } from "./ComposerAttachButton";

describe("Composer attachment", () => {
  it("opens the file chooser from the visible control and allows choosing the same file again", async () => {
    const user = userEvent.setup();
    const selected = vi.fn();
    render(<ComposerAttachButton onFileSelected={selected} onRefused={vi.fn()} />);
    const input = screen.getByLabelText("Choose attachment file");
    const choose = vi.spyOn(input, "click");
    await user.click(screen.getByRole("button", { name: "Add attachment" }));
    expect(choose).toHaveBeenCalledOnce();
    expect(input).toHaveAttribute("tabindex", "-1");
    expect(input).not.toBeVisible();
    const file = new File(["image"], "reference.png", { type: "image/png" });
    await user.upload(input, file);
    await user.upload(input, file);
    expect(selected).toHaveBeenCalledTimes(2);
    expect(selected).toHaveBeenLastCalledWith(file);
  });

  it("explains a refusal without opening the chooser or accepting a stale selection", async () => {
    const user = userEvent.setup();
    const selected = vi.fn();
    const refused = vi.fn();
    render(
      <ComposerAttachButton
        onFileSelected={selected}
        onRefused={refused}
        refusedReason="Choose a model that accepts images."
      />,
    );
    const input = screen.getByLabelText("Choose attachment file");
    const choose = vi.spyOn(input, "click");
    await user.click(screen.getByRole("button", { name: "Add attachment" }));
    expect(refused).toHaveBeenCalledWith("Choose a model that accepts images.");
    expect(choose).not.toHaveBeenCalled();
    fireEvent.change(input, {
      target: { files: { item: () => new File(["image"], "reference.png") } },
    });
    expect(selected).not.toHaveBeenCalled();
  });
});
