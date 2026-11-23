import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ComposerInput, type ComposerInputElement } from "./ComposerInput";

const instance = "6f1e0c52-2b7d-4c1a-9f3e-0a1b2c3d4e5f";
const tag = `@model(${instance}/gpt-5, reasoning=high)`;

function Prompt(props: {
  readonly initial?: string;
  readonly onValue?: (value: string, caret: number) => void;
}) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <>
      <label htmlFor="prompt">Message</label>
      <ComposerInput
        id="prompt"
        onChange={(event) => {
          setValue(event.currentTarget.value);
          props.onValue?.(event.currentTarget.value, event.currentTarget.selectionStart);
        }}
        placeholder="Ask anything"
        renderModelChip={(match) => (
          <span data-testid="chip">{`${match.tag.modelId} · ${match.tag.reasoning ?? "default"}`}</span>
        )}
        value={value}
      />
    </>
  );
}

describe("ComposerInput", () => {
  it("takes typing and reports the value and caret a text field would", async () => {
    const onValue = vi.fn();
    render(<Prompt onValue={onValue} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(input, "hello");
    expect(input).toHaveValue("hello");
    expect(onValue).toHaveBeenLastCalledWith("hello", 5);
  });

  it("accepts a value assigned with a change event", () => {
    render(<Prompt />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "set directly" } });
    expect(input).toHaveValue("set directly");
    expect(input).toHaveTextContent("set directly");
  });

  it("shows a model tag as one chip and counts it as its whole tag", () => {
    render(<Prompt initial={`Review ${tag} now`} />);
    const input = screen.getByRole<ComposerInputElement>("textbox", { name: "Message" });
    expect(screen.getByTestId("chip")).toHaveTextContent("gpt-5 · high");
    expect(input).toHaveValue(`Review ${tag} now`);
    input.focus();
    input.setSelectionRange(7 + tag.length, 7 + tag.length);
    expect(input.selectionStart).toBe(7 + tag.length);
  });

  it("turns a pasted tag back into a chip and keeps the pasted text plain", () => {
    render(<Prompt initial="a " />);
    const input = screen.getByRole<ComposerInputElement>("textbox", { name: "Message" });
    input.focus();
    input.setSelectionRange(2, 2);
    fireEvent.paste(input, { clipboardData: { getData: () => tag } });
    expect(input).toHaveValue(`a ${tag}`);
    expect(screen.getByTestId("chip")).toHaveTextContent("gpt-5 · high");
  });

  it("keeps selected text when a paste carries no text", () => {
    render(<Prompt initial="keep me" />);
    const input = screen.getByRole<ComposerInputElement>("textbox", { name: "Message" });
    input.focus();
    input.setSelectionRange(0, 4);
    fireEvent.paste(input, { clipboardData: { getData: () => "" } });
    expect(input).toHaveValue("keep me");
  });

  it("forgets its undo history when the caller replaces the value, as after a send", async () => {
    function Sent() {
      const [value, setValue] = useState("");
      return (
        <>
          <ComposerInput
            aria-label="Message"
            onChange={(event) => setValue(event.currentTarget.value)}
            value={value}
          />
          <button onClick={() => setValue("")} type="button">
            Send
          </button>
        </>
      );
    }
    render(<Sent />);
    const input = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(input, "sent text");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    input.focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(input).toHaveValue("");
  });

  it("copies a selected chip as its tag text", () => {
    render(<Prompt initial={tag} />);
    const input = screen.getByRole<ComposerInputElement>("textbox", { name: "Message" });
    input.focus();
    input.setSelectionRange(0, tag.length);
    const setData = vi.fn();
    fireEvent.copy(input, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", tag);
  });

  it("inserts a line break on Shift+Enter and undoes it", async () => {
    render(<Prompt initial="one" />);
    const input = screen.getByRole<ComposerInputElement>("textbox", { name: "Message" });
    input.focus();
    input.setSelectionRange(3, 3);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(input).toHaveValue("one\n");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(input).toHaveValue("one");
  });

  it("is disabled and read-only the way callers and tests expect", () => {
    const { rerender } = render(<ComposerInput aria-label="Prompt" disabled value="" />);
    expect(screen.getByRole("textbox", { name: "Prompt" })).toBeDisabled();
    rerender(<ComposerInput aria-label="Prompt" readOnly value="" />);
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveAttribute("readonly");
  });
});
