import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OctantCommandProvider } from "../palette/CommandRegistry";
import { ComposerSlashTypeahead, useComposerSlashCommands } from "./useComposerSlashCommands";

function Harness(props: { readonly resolve: (reference: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const slash = useComposerSlashCommands({
    draft,
    onDraftChange: setDraft,
    onResolveExtensionReference: props.resolve,
    textarea: () => textarea.current,
  });
  return (
    <>
      <textarea
        aria-label="Message"
        ref={textarea}
        value={draft}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          slash.sync(event.currentTarget.value, event.currentTarget.selectionStart);
        }}
        onKeyDown={(event) => {
          slash.handleKeyDown(event);
        }}
      />
      <ComposerSlashTypeahead controller={slash} />
      <button disabled={slash.resolving}>Send</button>
    </>
  );
}
function renderComposer(resolve: (reference: string) => Promise<boolean>) {
  return render(
    <OctantCommandProvider
      commands={[
        {
          id: "skill:review",
          title: "Review",
          group: "Skills",
          keywords: ["review"],
          action: { kind: "address", reference: "$review" },
        },
      ]}
    >
      <Harness resolve={resolve} />
    </OctantCommandProvider>,
  );
}

describe("composer slash selection", () => {
  it("keeps typing available and focus in the message while a chosen skill resolves", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<boolean>();
    const resolve = vi.fn(() => pending.promise);
    renderComposer(resolve);
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "/review");
    await user.click(screen.getByRole("option", { name: /Review/ }));
    expect(message).toHaveFocus();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.keyboard("Keep typing");
    expect(message).toHaveValue("Keep typing");
    expect(resolve).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("does not choose a skill while an IME composition is being committed", async () => {
    const user = userEvent.setup();
    const resolve = vi.fn(async () => true);
    renderComposer(resolve);
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "/review");
    fireEvent.keyDown(message, { key: "Enter", isComposing: true });
    expect(resolve).not.toHaveBeenCalled();
    expect(message).toHaveValue("/review");
  });
});
