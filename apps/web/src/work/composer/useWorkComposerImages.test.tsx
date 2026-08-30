import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { useWorkComposerImages } from "./useWorkComposerImages";

function Harness() {
  const images = useWorkComposerImages();
  const detached = useRef<ReadonlyArray<File>>([]);
  return (
    <div>
      <button
        onClick={() =>
          images.attach([new File([new Uint8Array([1])], "captured.png", { type: "image/png" })])
        }
        type="button"
      >
        attach
      </button>
      <button
        onClick={() => {
          detached.current = images.takeForSend();
        }}
        type="button"
      >
        detach
      </button>
      <button onClick={() => images.restore(detached.current)} type="button">
        restore
      </button>
      <button
        onClick={() =>
          images.attach([new File([new Uint8Array([2])], "later.png", { type: "image/png" })])
        }
        type="button"
      >
        attach later
      </button>
      <output aria-label="images">
        {images.staged.map((image) => image.displayName).join(",")}
      </output>
    </div>
  );
}

describe("useWorkComposerImages", () => {
  it("detaches a steered image without taking a later image with it", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "attach" }));
    fireEvent.click(screen.getByRole("button", { name: "detach" }));
    fireEvent.click(screen.getByRole("button", { name: "attach later" }));

    expect(screen.getByLabelText("images")).toHaveTextContent("later.png");
  });

  it("restores a detached image when its send is refused", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "attach" }));
    fireEvent.click(screen.getByRole("button", { name: "detach" }));
    fireEvent.click(screen.getByRole("button", { name: "restore" }));

    expect(screen.getByLabelText("images")).toHaveTextContent("captured.png");
  });
});
