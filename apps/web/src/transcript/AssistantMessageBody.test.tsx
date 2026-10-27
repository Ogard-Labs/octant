import { act, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageBody, StreamRepliesContext } from "./AssistantMessageBody";

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

describe("streaming display beats", () => {
  it("shows the first content immediately, then paints appended deltas on one beat", () => {
    vi.useFakeTimers();
    const view = render(<AssistantMessageBody body="" streaming />);
    view.rerender(<AssistantMessageBody body="The first" streaming />);
    expect(screen.getByText("The first")).toBeVisible();
    act(() => {
      view.rerender(<AssistantMessageBody body="The first words" streaming />);
      view.rerender(<AssistantMessageBody body="The first words arrive" streaming />);
    });
    expect(screen.getByText("The first")).toBeVisible();
    expect(screen.queryByText("The first words arrive")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByText("The first words arrive")).toBeVisible();
    act(() => {
      view.rerender(<AssistantMessageBody body="The first words arrive later" streaming />);
    });
    act(() => vi.advanceTimersByTime(15));
    act(() => {
      view.rerender(<AssistantMessageBody body="The first words arrive later still" streaming />);
    });
    act(() => vi.advanceTimersByTime(15));
    expect(screen.getByText("The first words arrive")).toBeVisible();
    act(() => vi.advanceTimersByTime(20));
    expect(screen.getByText("The first words arrive later still")).toBeVisible();
  });

  it("shows the finished answer and its final reference link without waiting", () => {
    vi.useFakeTimers();
    const view = render(<AssistantMessageBody body="See [the guide][g]." streaming />);
    const baseline = vi.getTimerCount();
    act(() => {
      view.rerender(<AssistantMessageBody body="See [the guide][g]. It" streaming />);
    });
    expect(vi.getTimerCount()).toBe(baseline + 1);
    act(() => {
      view.rerender(
        <AssistantMessageBody
          body={"See [the guide][g]. It covers setup.\n\n[g]: https://example.com/guide"}
          streaming={false}
        />,
      );
    });
    expect(screen.getByRole("link", { name: "the guide" })).toHaveAttribute(
      "href",
      "https://example.com/guide",
    );
    expect(vi.getTimerCount()).toBe(baseline);
  });

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

  it("cancels a pending beat on unmount and updates completed bodies synchronously", () => {
    vi.useFakeTimers();
    const view = render(<AssistantMessageBody body="Partial" streaming />);
    const baseline = vi.getTimerCount();
    act(() => {
      view.rerender(<AssistantMessageBody body="Partial more" streaming />);
    });
    expect(vi.getTimerCount()).toBe(baseline + 1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    const done = render(<AssistantMessageBody body="Done" streaming={false} />);
    act(() => {
      done.rerender(<AssistantMessageBody body="Done and revised" streaming={false} />);
    });
    expect(screen.getByText("Done and revised")).toBeVisible();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("keeps expanded reasoning open across a beat", () => {
    vi.useFakeTimers();
    const view = render(
      <AssistantMessageBody body={"<think>Step one.</think>Partial"} streaming />,
    );
    fireEvent.click(screen.getByText("Thinking"));
    expect(screen.getByText("Step one.")).toBeVisible();
    const disclosure = screen.getByText("Step one.").closest("details");
    act(() => {
      view.rerender(
        <AssistantMessageBody body={"<think>Step one.</think>Partial more"} streaming />,
      );
    });
    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByText("Partial more")).toBeVisible();
    const after = screen.getByText("Step one.").closest("details");
    expect(after).toBe(disclosure);
    expect(after).toHaveProperty("open", true);
  });

  it("uses the longer beat for a long answer and still shows the finish at once", () => {
    vi.useFakeTimers();
    const base = "Long answer start. " + "x".repeat(16_200);
    const view = render(<AssistantMessageBody body={base} streaming />);
    expect(screen.getByText(base)).toBeVisible();
    const baseline = vi.getTimerCount();
    act(() => {
      view.rerender(<AssistantMessageBody body={base + " more"} streaming />);
    });
    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByText(base)).toBeVisible();
    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByText(base + " more")).toBeVisible();
    act(() => {
      view.rerender(<AssistantMessageBody body={base + " more again"} streaming />);
    });
    expect(vi.getTimerCount()).toBe(baseline + 1);
    act(() => {
      view.rerender(<AssistantMessageBody body={base + " more again"} streaming={false} />);
    });
    expect(screen.getByText(base + " more again")).toBeVisible();
    expect(vi.getTimerCount()).toBe(baseline);
  });
});
