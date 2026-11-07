import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  decodeBrowserCompositionId,
  decodeBrowserEditorId,
  type HumanBrowserComposition,
  type HumanBrowserResult,
} from "@octant/contracts/browser-presentation";
import { EmbeddedBrowserTextInput } from "./EmbeddedBrowserTextInput";

it("cancels a pending acquisition after queued commit and blur before allowing its successor", async () => {
  const calls: HumanBrowserComposition[] = [];
  let resolveBegin: ((value: HumanBrowserResult) => void) | undefined;
  const pending = new Promise<HumanBrowserResult>((done) => {
    resolveBegin = done;
  });
  const id = decodeBrowserCompositionId("00000000-0000-4000-8000-000000000913");
  const second = decodeBrowserCompositionId("00000000-0000-4000-8000-000000000914");
  let acquisitions = 0;
  const compose = async (request: HumanBrowserComposition): Promise<HumanBrowserResult> => {
    calls.push(request);
    if (request.phase === "begin")
      return ++acquisitions === 1
        ? pending
        : { status: "composition-started", compositionId: second };
    return { status: "accepted" };
  };
  const group = createRef<HTMLDivElement>();
  const view = render(
    <div ref={group}>
      <EmbeddedBrowserTextInput
        group={group}
        pointerHeld={() => false}
        scaleX={1}
        scaleY={1}
        editor={{
          id: decodeBrowserEditorId("00000000-0000-4000-8000-000000000912"),
          selectionStart: 3,
          selectionEnd: 3,
          caret: { x: 87, y: 119, width: 0, height: 28 },
        }}
        compose={compose}
      />
    </div>,
  );
  try {
    const input = screen.getByLabelText("Browser text input");
    fireEvent.compositionStart(input);
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.compositionEnd(input, { data: "é" });
    fireEvent.blur(input);
    resolveBegin?.({ status: "composition-started", compositionId: id });
    await waitFor(() => expect(calls.map((call) => call.phase)).toEqual(["begin", "cancel"]));
    expect(calls[1]).toEqual({ phase: "cancel", compositionId: id });
    fireEvent.compositionStart(input);
    await waitFor(() => expect(acquisitions).toBe(2));
    fireEvent.compositionEnd(input, { data: "に" });
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({ phase: "commit", compositionId: second, text: "に" }),
    );
  } finally {
    view.unmount();
  }
});

it("moves the person's focus to a local password field for a page password field and back", async () => {
  const calls: HumanBrowserComposition[] = [];
  const typed: string[] = [];
  const group = createRef<HTMLDivElement>();
  const text = {
    id: decodeBrowserEditorId("00000000-0000-4000-8000-000000000915"),
    selectionStart: 0,
    selectionEnd: 0,
    caret: { x: 10, y: 12, width: 0, height: 20 },
  };
  const secure = {
    id: decodeBrowserEditorId("00000000-0000-4000-8000-000000000916"),
    secure: true as const,
  };
  const field = (editor: typeof text | typeof secure | undefined) => (
    <div ref={group} tabIndex={0}>
      <EmbeddedBrowserTextInput
        group={group}
        pointerHeld={() => false}
        scaleX={1}
        scaleY={1}
        editor={editor}
        compose={async (request) => {
          calls.push(request);
          return { status: "refused" };
        }}
        secureText={(value) => typed.push(value)}
      />
    </div>
  );
  // jsdom lays out nothing; the caret position needs only a rectangle.
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  const view = render(field(undefined));
  try {
    group.current?.focus();
    view.rerender(field(secure));
    const password = screen.getByLabelText("Browser password field") as HTMLInputElement;
    // Chromium turns on secure event input for a focused password field.
    await waitFor(() => expect(document.activeElement).toBe(password));
    expect(password.type).toBe("password");
    expect(password.getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByLabelText("Browser text input").getAttribute("contenteditable")).toBe(
      "false",
    );
    // A dead key's composed text goes on as typed characters and never stays.
    fireEvent.compositionStart(password);
    password.value = "é";
    fireEvent.compositionEnd(password, { data: "é" });
    expect(typed).toEqual(["é"]);
    expect(password.value).toBe("");
    expect(calls).toEqual([]);

    view.rerender(field(text));
    const input = screen.getByLabelText("Browser text input");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(password.getAttribute("aria-hidden")).toBe("true");

    view.rerender(field(secure));
    await waitFor(() => expect(document.activeElement).toBe(password));
    view.rerender(field(undefined));
    await waitFor(() => expect(document.activeElement).toBe(group.current));
  } finally {
    view.unmount();
  }
});
