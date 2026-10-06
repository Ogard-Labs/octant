import type { HomeCardCustomization } from "@octant/contracts/shell";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activity, GitPullRequest } from "lucide-react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeDashboard } from "./HomeDashboard";
import type { HomeCardContent, HomeCardDefinition } from "./homeCards";

function card(id: string, overrides: Partial<HomeCardDefinition> = {}): HomeCardDefinition {
  return {
    id,
    title: id,
    icon: Activity,
    defaultOn: true,
    available: true,
    emptyLabel: `${id} is quiet.`,
    useContent: () => ({ status: "ready", count: 2, body: <p>{`${id} body`}</p> }),
    ...overrides,
  };
}

/** Holds the choice the way the shell does: a change comes back in as the new prop. */
function Harness(props: {
  readonly cards: ReadonlyArray<HomeCardDefinition>;
  readonly initial?: HomeCardCustomization;
  readonly onChange?: (next: HomeCardCustomization) => void;
}) {
  const [customization, setCustomization] = useState<HomeCardCustomization>(
    props.initial ?? { order: [], visibility: [] },
  );
  return (
    <HomeDashboard
      cards={props.cards}
      customization={customization}
      onCustomizationChange={(next) => {
        props.onChange?.(next);
        setCustomization(next);
      }}
    />
  );
}

function cardTitles(): ReadonlyArray<string> {
  const grid = document.querySelector(".home-dashboard__grid");
  return grid === null
    ? []
    : within(grid as HTMLElement)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent ?? "");
}

async function openCustomize(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Customize" }));
  return await screen.findByRole("list", { name: "Cards" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the start-screen card area", () => {
  it("waits for the frame after the composer paints before it reads or shows anything", () => {
    const pending: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pending.push(callback);
      return pending.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const read = vi.fn((): HomeCardContent => ({ status: "ready", count: 1, body: <p>rows</p> }));

    render(
      <>
        <textarea aria-label="Message" />
        <HomeDashboard
          cards={[card("one", { useContent: read })]}
          customization={{ order: [], visibility: [] }}
          onCustomizationChange={vi.fn()}
        />
      </>,
    );

    expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Home cards" })).toBeNull();
    expect(read).not.toHaveBeenCalled();

    act(() => pending.forEach((callback) => callback(0)));

    expect(screen.getByRole("region", { name: "Home cards" })).toBeInTheDocument();
    expect(read).toHaveBeenCalled();
  });

  it("shows each card with its icon title, a count, and its body", async () => {
    render(<Harness cards={[card("one"), card("two")]} />);
    await screen.findByRole("region", { name: "Home cards" });
    const one = screen.getByRole("region", { name: "one" });
    expect(within(one).getByText("2")).toBeInTheDocument();
    expect(within(one).getByText("one body")).toBeInTheDocument();
    expect(cardTitles()).toEqual(["one", "two"]);
  });

  it("says an empty card is empty in one quiet line, with no count", async () => {
    render(
      <Harness
        cards={[
          card("one", { useContent: () => ({ status: "ready", count: 0, body: <p>no</p> }) }),
        ]}
      />,
    );
    const one = await screen.findByRole("region", { name: "one" });
    expect(within(one).getByText("one is quiet.")).toBeInTheDocument();
    expect(within(one).queryByText("no")).toBeNull();
    expect(one.querySelector(".home-card__count")).toBeNull();
  });

  it("drops a card that hides when empty instead of showing its line", async () => {
    render(
      <Harness
        cards={[
          card("one"),
          card("quiet", {
            hideWhenEmpty: true,
            useContent: () => ({ status: "ready", count: 0, body: null }),
          }),
        ]}
      />,
    );
    await screen.findByRole("region", { name: "one" });
    expect(screen.queryByRole("region", { name: "quiet" })).toBeNull();
  });

  it("keeps the place of a card that is still loading with one quiet line", async () => {
    render(<Harness cards={[card("one", { useContent: () => ({ status: "loading" }) })]} />);
    const one = await screen.findByRole("region", { name: "one" });
    expect(within(one).getByText("Looking…")).toBeInTheDocument();
  });

  it("hides a card whose capability is missing, in the grid and in Customize", async () => {
    const user = userEvent.setup();
    render(<Harness cards={[card("one"), card("github", { available: false })]} />);
    await screen.findByRole("region", { name: "one" });
    expect(screen.queryByRole("region", { name: "github" })).toBeNull();
    const list = await openCustomize(user);
    expect(within(list).queryByText("github")).toBeNull();
  });

  it("draws nothing when no card can be offered here", async () => {
    const { container } = render(<Harness cards={[card("github", { available: false })]} />);
    await waitFor(() => expect(container.querySelector(".home-dashboard")).toBeNull());
  });

  it("does not read a card that is switched off", async () => {
    const read = vi.fn((): HomeCardContent => ({ status: "ready", count: 1, body: <p>x</p> }));
    render(
      <Harness
        cards={[card("one"), card("off", { useContent: read })]}
        initial={{ order: [], visibility: [{ id: "off", visible: false }] }}
      />,
    );
    await screen.findByRole("region", { name: "one" });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("Customize", () => {
  it("switches a card off and on and stores each choice", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness cards={[card("one"), card("two")]} onChange={onChange} />);
    const list = await openCustomize(user);

    await user.click(within(list).getByRole("switch", { name: "Show one" }));
    expect(onChange).toHaveBeenLastCalledWith({
      order: [],
      visibility: [{ id: "one", visible: false }],
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "one" })).toBeNull());
    expect(screen.getByRole("region", { name: "two" })).toBeInTheDocument();

    await user.click(within(list).getByRole("switch", { name: "Show one" }));
    expect(onChange).toHaveBeenLastCalledWith({ order: [], visibility: [] });
    expect(await screen.findByRole("region", { name: "one" })).toBeInTheDocument();
  });

  it("keeps Customize reachable when every card is off", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        cards={[card("one")]}
        initial={{ order: [], visibility: [{ id: "one", visible: false }] }}
      />,
    );
    expect(document.querySelector(".home-dashboard__grid")).toBeNull();
    const list = await openCustomize(user);
    expect(within(list).getByRole("switch", { name: "Show one" })).not.toBeChecked();
  });

  it("moves a card with the up and down buttons and stores the new order", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        cards={[card("one"), card("two", { icon: GitPullRequest }), card("three")]}
        onChange={onChange}
      />,
    );
    const list = await openCustomize(user);
    expect(within(list).getByRole("button", { name: "Move one up" })).toBeDisabled();
    expect(within(list).getByRole("button", { name: "Move three down" })).toBeDisabled();

    await user.click(within(list).getByRole("button", { name: "Move three up" }));
    expect(onChange).toHaveBeenLastCalledWith({ order: ["one", "three", "two"], visibility: [] });
    await waitFor(() => expect(cardTitles()).toEqual(["one", "three", "two"]));

    await user.click(within(list).getByRole("button", { name: "Move one down" }));
    await waitFor(() => expect(cardTitles()).toEqual(["three", "one", "two"]));
  });

  it("moves a card by its keyboard-focused button without a pointer", async () => {
    const user = userEvent.setup();
    render(<Harness cards={[card("one"), card("two")]} />);
    await openCustomize(user);
    const down = screen.getByRole("button", { name: "Move one down" });
    down.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(cardTitles()).toEqual(["two", "one"]));
  });

  it("reorders by dragging a card's row onto another", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness cards={[card("one"), card("two"), card("three")]} onChange={onChange} />);
    const list = await openCustomize(user);
    const rows = within(list).getAllByRole("listitem");
    const dataTransfer = { effectAllowed: "", setData: vi.fn() };

    fireEvent.dragStart(rows[2] as HTMLElement, { dataTransfer });
    fireEvent.dragOver(rows[0] as HTMLElement, { dataTransfer });
    fireEvent.drop(rows[0] as HTMLElement, { dataTransfer });

    expect(onChange).toHaveBeenLastCalledWith({ order: ["three", "one", "two"], visibility: [] });
    await waitFor(() => expect(cardTitles()).toEqual(["three", "one", "two"]));
  });

  it("resets to the default order and switches, and is disabled while already default", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        cards={[card("one"), card("two")]}
        initial={{ order: ["two", "one"], visibility: [{ id: "one", visible: false }] }}
        onChange={onChange}
      />,
    );
    await openCustomize(user);
    await user.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(onChange).toHaveBeenLastCalledWith({ order: [], visibility: [] });
    await waitFor(() => expect(cardTitles()).toEqual(["one", "two"]));
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeDisabled();
  });
});
