import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
  BrowserUseMention,
  ComputerUseMention,
  useBrowserUseMention,
  useComputerUseMention,
} from "./ComputerUseMention";

function Composer() {
  const [draft, setDraft] = useState("");
  const computer = useComputerUseMention({
    draft,
    onDraftChange: setDraft,
    scopeKey: "task",
    available: true,
  });
  return (
    <>
      <textarea
        aria-label="Message"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          computer.sync(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={computer.handleKeyDown}
      />
      <ComputerUseMention controller={computer} />
      <output>{computer.selection?.kind ?? "none"}</output>
    </>
  );
}

function BrowserComposer() {
  const [draft, setDraft] = useState("");
  const browser = useBrowserUseMention({
    draft,
    onDraftChange: setDraft,
    scopeKey: "task",
    available: true,
  });
  return (
    <>
      <textarea
        aria-label="Message"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          browser.sync(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={browser.handleKeyDown}
      />
      <BrowserUseMention controller={browser} />
      <output>{browser.selection?.kind ?? "none"}</output>
    </>
  );
}

describe("Computer plugin mention", () => {
  it("turns an explicit @Computer choice into a removable structured plugin selection", () => {
    render(<Composer />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Use @Com", selectionStart: 8 },
    });
    fireEvent.click(screen.getByRole("option", { name: /Computer/ }));
    expect(screen.getByRole("textbox")).toHaveValue("Use ");
    expect(screen.getByText("plugin")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove Computer" }));
    expect(screen.getByText("none")).toBeVisible();
  });

  it("does not turn ordinary computer text into tool authority", () => {
    render(<Composer />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "My computer is slow", selectionStart: 19 },
    });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByText("none")).toBeVisible();
  });
});

describe("Browser plugin mention", () => {
  it("turns an explicit @Browser choice into a structured plugin selection", () => {
    render(<BrowserComposer />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Use @Bro", selectionStart: 8 },
    });
    fireEvent.click(screen.getByRole("option", { name: /Browser/ }));
    expect(screen.getByRole("textbox")).toHaveValue("Use ");
    expect(screen.getByText("plugin")).toBeVisible();
  });
});
