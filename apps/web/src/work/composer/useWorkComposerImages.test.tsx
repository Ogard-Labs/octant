import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useRef } from "react";
import { describe, expect, it } from "vitest";
import {
  createNewTaskDrafts,
  NewTaskDraftsContext,
  NewTaskDraftScopeContext,
} from "../../composer/useNewTaskPrompt";
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
      {images.staged.map((image) => (
        <button key={image.id} onClick={() => images.remove(image.id)} type="button">
          {`remove ${image.displayName}`}
        </button>
      ))}
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

  it("keeps staged images when the composer remounts under the same draft scope", () => {
    const drafts = createNewTaskDrafts();
    function view() {
      return (
        <NewTaskDraftsContext.Provider value={drafts}>
          <NewTaskDraftScopeContext.Provider value="work-overview:test">
            <Harness />
          </NewTaskDraftScopeContext.Provider>
        </NewTaskDraftsContext.Provider>
      );
    }

    const rendered = render(view());
    fireEvent.click(screen.getByRole("button", { name: "attach" }));
    expect(screen.getByLabelText("images")).toHaveTextContent("captured.png");
    rendered.unmount();
    render(view());

    expect(screen.getByLabelText("images")).toHaveTextContent("captured.png");
  });

  it("removes a remounted attachment on the first click under StrictMode", () => {
    const drafts = createNewTaskDrafts();
    drafts.writeImages("work-overview:test", [
      new File([new Uint8Array([1])], "captured.png", { type: "image/png" }),
    ]);

    render(
      <StrictMode>
        <NewTaskDraftsContext.Provider value={drafts}>
          <NewTaskDraftScopeContext.Provider value="work-overview:test">
            <Harness />
          </NewTaskDraftScopeContext.Provider>
        </NewTaskDraftsContext.Provider>
      </StrictMode>,
    );

    expect(screen.getByLabelText("images")).toHaveTextContent("captured.png");
    fireEvent.click(screen.getByRole("button", { name: "remove captured.png" }));
    expect(screen.getByLabelText("images")).toHaveTextContent("");
  });

  it("does not keep attachments after the draft scope changes", () => {
    const drafts = createNewTaskDrafts();
    drafts.writeImages("work-overview:a", [
      new File([new Uint8Array([1])], "alpha.png", { type: "image/png" }),
    ]);
    function view(scope: string) {
      return (
        <NewTaskDraftsContext.Provider value={drafts}>
          <NewTaskDraftScopeContext.Provider value={scope}>
            <Harness />
          </NewTaskDraftScopeContext.Provider>
        </NewTaskDraftsContext.Provider>
      );
    }

    const rendered = render(view("work-overview:a"));
    expect(screen.getByLabelText("images")).toHaveTextContent("alpha.png");
    rendered.rerender(view("work-overview:b"));
    expect(screen.getByLabelText("images")).toHaveTextContent("");
  });
});
