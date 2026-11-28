import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useId, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  OctantListbox,
  OctantListboxInput,
  OctantListboxOption,
  useOctantListbox,
} from "./OctantListbox";

const ITEMS = [
  { id: "alpha", label: "Alpha" },
  { id: "beta", label: "Beta", disabled: true },
  { id: "gamma", label: "Gamma" },
  { id: "delta", label: "Delta" },
] as const;

function RovingListboxFixture(props: { readonly onChoose: (id: string) => void }) {
  const [selected, setSelected] = useState<string>("gamma");
  return (
    <div>
      <button type="button">Before</button>
      <OctantListbox aria-label="Items" navigation="roving">
        {ITEMS.map((item) => (
          <OctantListboxOption
            disabled={"disabled" in item && item.disabled}
            key={item.id}
            onClick={() => {
              setSelected(item.id);
              props.onChoose(item.id);
            }}
            selected={selected === item.id}
          >
            {item.label}
          </OctantListboxOption>
        ))}
      </OctantListbox>
      <button type="button">After</button>
    </div>
  );
}

function ComboboxFixture(props: {
  readonly onChoose: (id: string) => void;
  readonly onDismiss: () => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const visible = ITEMS.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
  const controller = useOctantListbox({
    count: visible.length,
    isIndexDisabled: (index) => {
      const item = visible[index];
      return item !== undefined && "disabled" in item && item.disabled === true;
    },
    onActivate: (index) => {
      const item = visible[index];
      if (item !== undefined) props.onChoose(item.id);
    },
    onDismiss: props.onDismiss,
  });

  const activeOption = controller.activeIndex >= 0 ? visible[controller.activeIndex] : undefined;
  return (
    <div>
      <OctantListboxInput
        activeDescendantId={activeOption === undefined ? undefined : `${listId}-${activeOption.id}`}
        aria-label="Filter items"
        controlsId={listId}
        expanded={visible.length > 0}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          controller.setActiveIndex(0);
        }}
        onKeyDown={(event) => {
          controller.handleKeyDown(event);
        }}
        value={query}
      />
      {visible.length === 0 ? (
        <p role="status">No matches</p>
      ) : (
        <OctantListbox
          activeDescendantId={
            activeOption === undefined ? undefined : `${listId}-${activeOption.id}`
          }
          aria-label="Filtered items"
          id={listId}
        >
          {visible.map((item, index) => (
            <OctantListboxOption
              active={index === controller.activeIndex}
              disabled={"disabled" in item && item.disabled}
              id={`${listId}-${item.id}`}
              key={item.id}
              onClick={() => props.onChoose(item.id)}
              selected={index === controller.activeIndex}
            >
              {item.label}
            </OctantListboxOption>
          ))}
        </OctantListbox>
      )}
    </div>
  );
}

describe("OctantListbox", () => {
  it("keeps one tab stop in roving mode, moves with arrows/Home/End/typeahead, and skips disabled options", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    render(<RovingListboxFixture onChoose={onChoose} />);

    expect(screen.getByRole("option", { name: "Gamma" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("option", { name: "Delta" })).toHaveAttribute("tabindex", "-1");

    screen.getByRole("button", { name: "Before" }).focus();
    await user.tab();
    expect(screen.getByRole("option", { name: "Gamma" })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();

    screen.getByRole("option", { name: "Alpha" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "Gamma" })).toHaveFocus();

    await user.keyboard("{End}");
    expect(screen.getByRole("option", { name: "Delta" })).toHaveFocus();

    await user.keyboard("{Home}");
    expect(screen.getByRole("option", { name: "Alpha" })).toHaveFocus();

    await user.keyboard("d");
    expect(screen.getByRole("option", { name: "Delta" })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onChoose).toHaveBeenCalledWith("delta");
  });

  it("drives combobox filtering, virtual focus, Enter activation, and Escape dismissal", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const onDismiss = vi.fn();
    render(<ComboboxFixture onChoose={onChoose} onDismiss={onDismiss} />);

    const input = screen.getByRole("combobox", { name: "Filter items" });
    await user.click(input);
    await user.keyboard("{ArrowDown}");
    // Skips disabled Beta and lands on Gamma.
    expect(screen.getByRole("option", { name: "Gamma" })).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    expect(screen.getByRole("option", { name: "Delta" })).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Enter}");
    expect(onChoose).toHaveBeenCalledWith("delta");

    await user.type(input, "zzz");
    expect(screen.getByRole("status")).toHaveTextContent("No matches");

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("leaves Shift+Enter untouched so multiline composers can insert newlines while a list is open", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    render(<ComboboxFixture onChoose={onChoose} onDismiss={vi.fn()} />);

    const input = screen.getByRole("combobox", { name: "Filter items" });
    await user.click(input);
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onChoose).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(onChoose).toHaveBeenCalledWith("alpha");
  });

  it("scrolls the active option into view when virtual focus lives on OctantListboxInput", async () => {
    const user = userEvent.setup();
    function InputOwnedFixture() {
      const listId = useId();
      const controller = useOctantListbox({
        count: ITEMS.length,
        initialActiveIndex: -1,
        isIndexDisabled: (index) => {
          const item = ITEMS[index];
          return item !== undefined && "disabled" in item && item.disabled === true;
        },
      });
      const active = controller.activeIndex >= 0 ? ITEMS[controller.activeIndex] : undefined;
      return (
        <div>
          <OctantListboxInput
            activeDescendantId={active === undefined ? undefined : `${listId}-${active.id}`}
            aria-label="Filter projects"
            controlsId={listId}
            expanded
            onKeyDown={(event) => {
              controller.handleKeyDown(event);
            }}
            value=""
            onChange={() => undefined}
          />
          <OctantListbox aria-label="Projects" id={listId}>
            {ITEMS.map((item, index) => (
              <OctantListboxOption
                active={index === controller.activeIndex}
                disabled={"disabled" in item && item.disabled}
                id={`${listId}-${item.id}`}
                key={item.id}
              >
                {item.label}
              </OctantListboxOption>
            ))}
          </OctantListbox>
        </div>
      );
    }

    render(<InputOwnedFixture />);
    const gamma = screen.getByRole("option", { name: "Gamma" });
    const scrollIntoView = vi.fn();
    gamma.scrollIntoView = scrollIntoView;

    const input = screen.getByRole("combobox", { name: "Filter projects" });
    await user.click(input);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });
});
