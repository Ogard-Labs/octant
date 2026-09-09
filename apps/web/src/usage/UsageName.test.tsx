import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
