import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentMessagingFactsRow } from "./AgentMessagingFactsRow";
import type { AgentMessageMessagingFacts } from "@octant/contracts";

const facts: AgentMessageMessagingFacts = {
  openInFlight: 2,
  maxOpenInFlightPerSender: 8,
  delivered: 11,
  refused: 3,
  recent: [
    {
      messageId: "10000000-0000-4000-8000-000000000001" as never,
      senderThreadId: "chat-0000-0000-4000-8000-00000000000a" as never,
      recipientThreadId: "code-0000-0000-4000-8000-00000000000b" as never,
      state: "refused",
      refuseReason: "recipient-terminal",
      occurredAt: "2026-09-10T12:00:00.000Z" as never,
    },
  ],
};

describe("AgentMessagingFactsRow", () => {
  it("states the open in-flight count against the cap and the settled counts", () => {
    render(<AgentMessagingFactsRow client={undefined} facts={facts} />);
    const row = screen.getByLabelText("Agent messaging bounds");
    expect(row.textContent).toContain("2 of 8 open messages per sender");
    expect(row.textContent).toContain("11 delivered");
    expect(row.textContent).toContain("3 refused");
  });

  it("states the latest refusal by its reason instead of stranding it silently", () => {
    render(<AgentMessagingFactsRow client={undefined} facts={facts} />);
    expect(screen.getByText(/Latest refusal: recipient closed/)).toBeVisible();
  });

  it("says nothing while it has no facts and no client to read them from", () => {
    const { container } = render(<AgentMessagingFactsRow client={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reads the facts from the client and refreshes on an interval", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        facts: vi.fn(async () => facts),
      } as never;
      render(<AgentMessagingFactsRow client={client} />);
      for (
        let flush = 0;
        flush < 20 && screen.queryByLabelText("Agent messaging bounds") === null;
        flush += 1
      ) {
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(screen.getByLabelText("Agent messaging bounds")).toBeVisible();
      const clientCalls = client as {
        readonly facts: { readonly mock: { readonly calls: unknown[] } };
      };
      const callCount = clientCalls.facts.mock.calls.length;
      expect(callCount).toBeGreaterThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(clientCalls.facts.mock.calls.length).toBeGreaterThan(callCount);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);
});
