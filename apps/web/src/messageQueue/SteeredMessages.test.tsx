import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { decodeUtcTimestamp } from "@octant/contracts";
import { SteeredMessages } from "./SteeredMessages";

describe("a message the person sent while the turn ran", () => {
  it("shows as the person's message inside that turn, labelled as sent while it ran", () => {
    render(
      <SteeredMessages
        steered={[
          {
            messageId: "92000000-0000-4000-8000-000000000041",
            body: "Use the staging database instead.",
            steeredAt: decodeUtcTimestamp("2026-11-21T12:00:00.000Z"),
          },
        ]}
      />,
    );
    const message = screen.getByRole("article", { name: "Your message, sent while the turn ran" });
    expect(message).toHaveTextContent("Sent while the turn ran");
    expect(message).toHaveTextContent("Use the staging database instead.");
  });

  it("shows nothing for a turn that took no message", () => {
    const { container } = render(<SteeredMessages steered={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
