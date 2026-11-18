import { act, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplyDetailLevel } from "@octant/contracts/shell";
import { AssistantMessageBody, StreamRepliesContext } from "./AssistantMessageBody";
import { ReplyDetailContext } from "./replyDetail";

afterEach(() => vi.useRealTimers());

it("waits for the finished answer while keeping reasoning expandable", () => {
  const body = "<think>Check the result.</think>The answer is ready.";
  const view = render(
    <StreamRepliesContext.Provider value={false}>
      <AssistantMessageBody body={body} streaming />
    </StreamRepliesContext.Provider>,
  );
  expect(screen.queryByText("The answer is ready.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Thinking"));
  expect(screen.getByText("Check the result.")).toBeVisible();
  view.rerender(
    <StreamRepliesContext.Provider value={false}>
      <AssistantMessageBody body={body} streaming={false} />
    </StreamRepliesContext.Provider>,
  );
  expect(screen.getByText("The answer is ready.")).toBeVisible();
});

it("streams the answer by default", () => {
  render(<AssistantMessageBody body="The partial answer" streaming />);
  expect(screen.getByText("The partial answer")).toBeVisible();
});

it("includes the tool status in its accessible name", () => {
  render(
    <AssistantMessageBody body={"```tool name=search status=running\nLooking up sources\n```"} />,
  );
  expect(screen.getByText("Tool · search").closest("summary")).toHaveAccessibleName(
    "Tool · search · running",
  );
});

describe("inline thinking and tool parts at each Reply detail level", () => {
  const body =
    "<think>Compare the two fixtures.\nThe second one is stale.</think>" +
    "```tool name=search status=completed\nThree sources found\n```\nThe answer.";

  function renderAt(level: ReplyDetailLevel) {
    return render(
      <ReplyDetailContext.Provider value={level}>
        <AssistantMessageBody body={body} />
      </ReplyDetailContext.Provider>,
    );
  }

  function details(name: string): HTMLDetailsElement {
    const element = screen.getByText(name).closest("details");
    if (!(element instanceof HTMLDetailsElement)) throw new Error(`No disclosure named ${name}`);
    return element;
  }

  it("keeps both shut at low, with no thinking preview", () => {
    renderAt("low");
    expect(details("Thinking").open).toBe(false);
    expect(details("Tool · search").open).toBe(false);
    expect(details("Thinking").querySelector("summary")?.textContent).toBe("Thinking");
    expect(screen.getByText(/Compare the two fixtures/)).not.toBeVisible();
  });

  it("previews the first line of shut thinking at medium without adding it to the name", () => {
    renderAt("medium");
    const summary = details("Thinking").querySelector("summary");
    expect(summary).toHaveAccessibleName("Thinking");
    expect(details("Thinking").open).toBe(false);
    const preview = screen
      .getAllByText("Compare the two fixtures.")
      .find((element) => summary?.contains(element));
    expect(preview).toBeVisible();
    expect(preview).toHaveAttribute("aria-hidden", "true");
    expect(details("Tool · search").open).toBe(false);
  });

  it("opens thinking and the tool's recorded summary at high, and lets the person close one", () => {
    renderAt("high");
    expect(details("Thinking").open).toBe(true);
    expect(screen.getByText("The second one is stale.", { exact: false })).toBeVisible();
    expect(details("Tool · search").open).toBe(true);
    expect(screen.getByText("Three sources found")).toBeVisible();

    fireEvent.click(screen.getByText("Thinking"));
    expect(details("Thinking").open).toBe(false);
    expect(details("Tool · search").open).toBe(true);
  });
});

describe("streaming display pace", () => {
  it("replaces a shrinking stream immediately and cannot restore the old text", () => {
    vi.useFakeTimers();
    const view = render(<AssistantMessageBody body="A longer partial answer" streaming />);
    act(() => {
      view.rerender(<AssistantMessageBody body="A longer partial answer plus" streaming />);
    });
    act(() => {
      view.rerender(<AssistantMessageBody body="Restarted" streaming />);
    });
    expect(screen.getByText("Restarted")).toBeVisible();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByText("Restarted")).toBeVisible();
    expect(screen.queryByText(/partial answer/)).not.toBeInTheDocument();
  });

  it("shows the first content immediately, then reveals appended deltas over frames", () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "performance",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    const view = render(<AssistantMessageBody body="" streaming />);
    view.rerender(<AssistantMessageBody body="The first" streaming />);
    expect(screen.getByText("The first")).toBeVisible();
    const full = "The first words arrive in a burst and keep going for a while";
    act(() => {
      view.rerender(<AssistantMessageBody body={full} streaming />);
    });
    expect(screen.queryByText(full)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText(full)).toBeVisible();
  });

  it("shows the finished answer and its final reference link within 100 ms", () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "performance",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    const view = render(<AssistantMessageBody body="See [the guide][g]." streaming />);
    act(() => {
      view.rerender(<AssistantMessageBody body="See [the guide][g]. It covers setup." streaming />);
    });
    act(() => {
      view.rerender(
        <AssistantMessageBody
          body={"See [the guide][g]. It covers setup.\n\n[g]: https://example.com/guide"}
          streaming={false}
        />,
      );
    });
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole("link", { name: "the guide" })).toHaveAttribute(
      "href",
      "https://example.com/guide",
    );
  });

  it("updates a settled body synchronously and stops its frames on unmount", () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "performance",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    const view = render(<AssistantMessageBody body="Partial" streaming />);
    act(() => {
      view.rerender(<AssistantMessageBody body="Partial more words" streaming />);
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    const done = render(<AssistantMessageBody body="Done" streaming={false} />);
    act(() => {
      done.rerender(<AssistantMessageBody body="Done and revised" streaming={false} />);
    });
    expect(screen.getByText("Done and revised")).toBeVisible();
  });

  it("keeps expanded reasoning open while the answer is revealed", () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "performance",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    const view = render(
      <AssistantMessageBody body={"<think>Step one.</think>Partial"} streaming />,
    );
    fireEvent.click(screen.getByText("Thinking"));
    const disclosure = screen.getByText("Step one.").closest("details");
    act(() => {
      view.rerender(
        <AssistantMessageBody body={"<think>Step one.</think>Partial more"} streaming />,
      );
    });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByText("Partial more")).toBeVisible();
    const after = screen.getByText("Step one.").closest("details");
    expect(after).toBe(disclosure);
    expect(after).toHaveProperty("open", true);
  });
});
