import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SettingsDeepLink } from "@octant/contracts";
import type { SettingsSearchResult } from "./registry";
import { SettingsSearchResults } from "./SettingsSearchResults";

const SECTION_LABELS = {
  general: "General",
  appearance: "Appearance",
  providers: "Providers & Models",
} as const;

const RESULTS: ReadonlyArray<SettingsSearchResult> = [
  {
    kind: "setting",
    sectionId: "appearance",
    settingId: "sidebar-width",
    label: "Sidebar width",
    scope: "app",
  },
  {
    kind: "setting",
    sectionId: "appearance",
    settingId: "sidebar-material",
    label: "Translucent sidebar",
    scope: "app",
  },
  {
    kind: "section",
    sectionId: "providers",
    label: "Providers & Models",
    scope: "app",
  },
];

describe("SettingsSearchResults", () => {
  it("renders nothing for an empty query", () => {
    const { container } = render(
      <SettingsSearchResults
        query=""
        results={[]}
        sectionLabels={SECTION_LABELS}
        onSelect={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists results as a listbox with one option per result showing label, section, and scope", () => {
    render(
      <SettingsSearchResults
        query="sidebar"
        results={RESULTS}
        sectionLabels={SECTION_LABELS}
        onSelect={vi.fn()}
      />,
    );
    const listbox = screen.getByRole("listbox", { name: "Settings search results" });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(listbox).toContainElement(options[0]!);
    expect(options[0]).toHaveTextContent("Sidebar width");
    expect(options[0]).toHaveTextContent("Appearance");
    expect(options[0]).toHaveTextContent("This app");
    expect(options[2]).toHaveTextContent("Providers & Models");
  });

  it("selects a setting result on click with a section plus setting deep link", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SettingsSearchResults
        query="sidebar"
        results={RESULTS}
        sectionLabels={SECTION_LABELS}
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("option", { name: /Sidebar width/i }));
    const expected: SettingsDeepLink = { section: "appearance", setting: "sidebar-width" };
    expect(onSelect).toHaveBeenCalledWith(expected);
  });

  it("selects a section result on click with a section-only deep link", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SettingsSearchResults
        query="providers"
        results={RESULTS}
        sectionLabels={SECTION_LABELS}
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("option", { name: /Providers & Models/i }));
    expect(onSelect).toHaveBeenCalledWith({ section: "providers" });
  });

  it("moves the active option with ArrowDown/ArrowUp and selects with Enter", () => {
    const onSelect = vi.fn();
    render(
      <SettingsSearchResults
        query="sidebar"
        results={RESULTS}
        sectionLabels={SECTION_LABELS}
        onSelect={onSelect}
      />,
    );
    const listbox = screen.getByRole("listbox", { name: "Settings search results" });
    const options = screen.getAllByRole("option");

    listbox.focus();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ section: "appearance", setting: "sidebar-width" });
  });

  it("wraps keyboard navigation from the last option back to the first", () => {
    render(
      <SettingsSearchResults
        query="sidebar"
        results={RESULTS}
        sectionLabels={SECTION_LABELS}
        onSelect={vi.fn()}
      />,
    );
    const listbox = screen.getByRole("listbox", { name: "Settings search results" });
    const options = screen.getAllByRole("option");

    listbox.focus();
    // Move to the last option first.
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    // One more Down wraps to the first.
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("shows a no-results recovery message when the query matches nothing", () => {
    render(
      <SettingsSearchResults
        query="zzz"
        results={[]}
        sectionLabels={SECTION_LABELS}
        onSelect={vi.fn()}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/no settings match/i);
  });

  it("resets the active option when the result set changes", () => {
    const { rerender } = render(
      <SettingsSearchResults
        query="sidebar"
        results={RESULTS}
        sectionLabels={SECTION_LABELS}
        onSelect={vi.fn()}
      />,
    );
    const listbox = screen.getByRole("listbox", { name: "Settings search results" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

    rerender(
      <SettingsSearchResults
        query="providers"
        results={[RESULTS[2]!]}
        sectionLabels={SECTION_LABELS}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  });
});
