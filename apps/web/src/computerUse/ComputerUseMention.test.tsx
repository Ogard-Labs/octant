import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
  ApplicationMentionTypeahead,
  BrowserUseMention,
  ComputerUseMention,
  useApplicationMentionTypeahead,
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

function BothComposer() {
  const [draft, setDraft] = useState("");
  const computer = useComputerUseMention({
    draft,
    onDraftChange: setDraft,
    scopeKey: "task",
    available: true,
  });
  const browser = useBrowserUseMention({
    draft,
    onDraftChange: setDraft,
    scopeKey: "task",
    available: true,
  });
  const appMentions = useApplicationMentionTypeahead([
    { controller: computer, kind: "computer" },
    { controller: browser, kind: "browser" },
  ]);
  return (
    <>
      <textarea
        aria-label="Message"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          computer.sync(event.target.value, event.target.selectionStart);
          browser.sync(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={(event) => {
          if (appMentions.handleKeyDown(event)) return;
          if (computer.handleKeyDown(event)) return;
          browser.handleKeyDown(event);
        }}
      />
      {appMentions.open.length > 1 ? (
        <ApplicationMentionTypeahead typeahead={appMentions} />
      ) : computer.open ? (
        <ComputerUseMention controller={computer} />
      ) : (
        <BrowserUseMention controller={browser} />
      )}
      <output>{computer.selection?.kind ?? browser.selection?.kind ?? "none"}</output>
    </>
  );
}

describe("Application mention typeahead", () => {
  it("lists every matching application on a bare @ instead of hiding the rest", () => {
    render(<BothComposer />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "@", selectionStart: 1 },
    });
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "ComputerComputer use",
      "BrowserBuilt-in browser",
    ]);
  });

  it("moves the highlight with arrows and chooses the highlighted application", () => {
    render(<BothComposer />);
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "@", selectionStart: 1 } });
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Browser/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(textbox).toHaveValue("");
    expect(screen.getByText("plugin")).toBeVisible();
  });

  it("still narrows to a single application as the query names it", () => {
    render(<BothComposer />);
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "@b", selectionStart: 2 } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Browser");
  });
});
