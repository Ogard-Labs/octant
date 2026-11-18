import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkComposerImages } from "./useWorkComposerImages";
import { WorkImageAttachmentChips } from "./WorkImageAttachmentChips";

function imagesOf(names: ReadonlyArray<string>): WorkComposerImages {
  return {
    staged: names.map((name, index) => ({
      id: `image-${index}`,
      file: new File([new Uint8Array(2048)], name, { type: "image/png" }),
      displayName: name,
      previewUrl: `blob:${name}`,
    })),
    message: undefined,
    remove: vi.fn(),
  } as unknown as WorkComposerImages;
}

describe("WorkImageAttachmentChips", () => {
  it("opens a staged image large with its name and size and steps between images with the arrow keys", async () => {
    const user = userEvent.setup();
    render(<WorkImageAttachmentChips images={imagesOf(["first.png", "second.png"])} />);

    await user.click(screen.getByRole("button", { name: "Preview first.png" }));
    const dialog = await screen.findByRole("dialog", { name: "Preview first.png" });
    expect(dialog).toHaveTextContent("first.png");
    expect(dialog).toHaveTextContent("2.0 KB · 1 of 2");

    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("dialog", { name: "Preview second.png" })).toHaveTextContent(
      "2 of 2",
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
