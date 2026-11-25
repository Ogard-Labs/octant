import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkComposerImages } from "./useWorkComposerImages";
import { WorkImageAttachmentChips } from "./WorkImageAttachmentChips";

// This suite gets its own import result because React.lazy caches the first one.
vi.mock("../../composer/ImagePreviewLightbox", () => {
  throw new Error("The preview module failed to load.");
});

afterEach(() => vi.restoreAllMocks());

function ComposerAttachments() {
  const images = useWorkComposerImages();
  return (
    <>
      <input
        aria-label="Attach a file"
        type="file"
        onChange={(event) => {
          images.attach(Array.from(event.currentTarget.files ?? []));
        }}
      />
      <WorkImageAttachmentChips images={images} />
    </>
  );
}

it("keeps the staged attachment removable after dismissing an unavailable image preview", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:staged-image");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const user = userEvent.setup();
  render(<ComposerAttachments />);
  await user.upload(
    screen.getByLabelText("Attach a file"),
    new File(["image"], "first.png", { type: "image/png" }),
  );

  await user.click(screen.getByRole("button", { name: "Preview first.png" }));
  expect(
    await screen.findByRole("dialog", { name: "Image preview unavailable" }),
  ).toHaveTextContent("Reload Octant to try opening the image again.");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  expect(screen.getByRole("button", { name: "Preview first.png" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Remove first.png" }));
  expect(screen.queryByRole("button", { name: "Preview first.png" })).toBeNull();
});
