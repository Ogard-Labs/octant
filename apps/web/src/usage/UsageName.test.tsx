import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { USAGE_ERASED_THREADS_KEY } from "@octant/contracts";
import { UsageName, UsageNamesProvider } from "./UsageName";

describe("usage identity labels", () => {
  it("uses known names and keeps the original identifier available", () => {
    render(
      <UsageNamesProvider
        names={
          new Map([
            ["provider/p1", "Local provider"],
            ["chat-thread/t1", "Holiday plans"],
          ])
        }
      >
        <UsageName kind="provider" id="p1" />
        <UsageName kind="chat-thread" id="t1" />
      </UsageNamesProvider>,
    );
    expect(screen.getByText("Local provider")).toHaveAttribute("title", "p1");
    expect(screen.getByText("Holiday plans")).toHaveAttribute("title", "t1");
  });
  it("keeps unresolved subjects distinguishable without displaying a full UUID", () => {
    render(<UsageName kind="code-thread" id="12345678-1234-4123-8123-123456789012" />);
    expect(screen.getByText("Code task · 12345678…")).toHaveAttribute(
      "title",
      "12345678-1234-4123-8123-123456789012",
    );
  });
  it("reads usage from purged threads as erased threads, even when a row's subject is purged while it is shown", () => {
    const { rerender } = render(<UsageName kind="chat-thread" id="t1" />);
    expect(screen.getByText("t1")).toBeInTheDocument();
    rerender(<UsageName kind="chat-thread" id={null} />);
    expect(screen.getByText("Erased threads")).toBeInTheDocument();
    rerender(<UsageName kind="thread" id={USAGE_ERASED_THREADS_KEY} />);
    expect(screen.getByText("Erased threads")).toHaveAttribute(
      "title",
      expect.stringContaining("purged"),
    );
  });
});
