import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BrowserAgentStatus } from "./BrowserAgentStatus";

it("names admission, Plan and unknown states without offering a new permission", () => {
  const view = render(
    <BrowserAgentStatus availability={{ status: "available", readOnly: false }} />,
  );
  expect(screen.getByText("Agent can use this Browser.")).toBeVisible();
  view.rerender(<BrowserAgentStatus availability={{ status: "available", readOnly: true }} />);
  expect(screen.getByText("Agent can read this Browser in Plan.")).toBeVisible();
  view.rerender(<BrowserAgentStatus availability={undefined} />);
  expect(screen.getByText("Browser availability is unknown.")).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(
    <BrowserAgentStatus agentDriving availability={{ status: "available", readOnly: false }} />,
  );
  expect(screen.queryByRole("status")).toBeNull();
});

it.each(["no-tool-transport", "excluded-by-thread-constraints", "host-lends-no-browser"] as const)(
  "keeps the specific omission and its existing recovery action available: %s",
  (reason) => {
    const recover = vi.fn();
    render(<BrowserAgentStatus availability={{ status: "omitted", reason }} onRecover={recover} />);
    const button = screen.getByRole("button");
    expect(button).toHaveAccessibleName(/The agent cannot use this Browser/);
    fireEvent.click(button);
    expect(recover).toHaveBeenCalledWith(reason);
  },
);
