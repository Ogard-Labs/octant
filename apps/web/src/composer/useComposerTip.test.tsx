import { StrictMode, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useComposerTip, type ComposerTipContext } from "./useComposerTip";

function Composer(props: ComposerTipContext) {
  const [draft, setDraft] = useState("");
  const tip = useComposerTip(props);
  return (
    <textarea
      aria-label="Message"
      placeholder={tip}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

describe("composer tips", () => {
  it("keeps the tip steady while writing and changes it when visiting a different thread", () => {
    const { rerender, unmount } = render(
      <StrictMode>
        <Composer scopeKey="thread-a" />
      </StrictMode>,
    );
    const field = screen.getByRole("textbox");
    const first = field.getAttribute("placeholder");
    expect(first).toMatch(/^Tip: /);
    fireEvent.change(field, { target: { value: "Keep this draft" } });
    rerender(
      <StrictMode>
        <Composer scopeKey="thread-a" />
      </StrictMode>,
    );
    expect(field).toHaveAttribute("placeholder", first);
    expect(field).toHaveValue("Keep this draft");
    rerender(
      <StrictMode>
        <Composer scopeKey="thread-b" />
      </StrictMode>,
    );
    const second = field.getAttribute("placeholder");
    expect(second).not.toBe(first);
    unmount();
    render(
      <StrictMode>
        <Composer scopeKey="new-thread" />
      </StrictMode>,
    );
    expect(screen.getByRole("textbox").getAttribute("placeholder")).not.toBe(second);
  });
  it("only teaches available features and replaces a tip when that feature disappears", () => {
    const { rerender } = render(<Composer scopeKey="visit-0" />);
    const field = screen.getByRole("textbox");
    const baseTips = new Set<string | null>();
    for (let index = 0; index < 8; index += 1) {
      rerender(<Composer scopeKey={`visit-${index}`} />);
      baseTips.add(field.getAttribute("placeholder"));
    }
    expect(baseTips).toEqual(
      new Set([
        "Tip: Use Shift+Enter to add a new line.",
        "Tip: Press Enter to send your message.",
      ]),
    );
    const discovered = new Set<string | null>();
    for (let index = 0; index < 24; index += 1) {
      rerender(
        <Composer scopeKey={`enabled-${index}`} files threads commands browser computer plan />,
      );
      discovered.add(field.getAttribute("placeholder"));
    }
    expect(discovered).toContain("Tip: Type @ to include a file from your checkout.");
    expect(discovered).toContain("Tip: Type # to bring another thread into context.");
    expect(discovered).toContain("Tip: Type / to find available commands.");
    expect(discovered).toContain("Tip: Mention @Browser to use Octant’s built-in browser.");
    expect(discovered).toContain("Tip: Mention @Computer to work with an app on your desktop.");
    expect(discovered).toContain(
      "Tip: Choose Plan for read-only exploration before making changes.",
    );
    rerender(<Composer scopeKey="enabled-23" />);
    expect(baseTips.has(field.getAttribute("placeholder"))).toBe(true);
  });
});
