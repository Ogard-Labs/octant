import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it } from "vitest";
import { AssistantMessageBody, StreamRepliesContext } from "./AssistantMessageBody";

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
