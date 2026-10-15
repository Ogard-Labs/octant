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

  it("lists each refused message with its sender, the thread it named, and the reason", () => {
    const refused = (id: string, reason: "unauthorized" | "policy") => ({
      messageId: `10000000-0000-4000-8000-0000000000${id}` as never,
      senderThreadId: "code-0000-0000-4000-8000-00000000000a" as never,
      recipientThreadId: `code-0000-0000-4000-8000-0000000000${id}` as never,
      state: "refused" as const,
      refuseReason: reason,
      occurredAt: new Date(Date.now() - 5 * 60_000).toISOString() as never,
    });
    render(
      <AgentMessagingFactsRow
        client={undefined}
        facts={{
          ...facts,
          refused: 2,
          recent: [refused("c1", "unauthorized"), refused("c2", "policy")],
        }}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("code-000…");
    expect(rows[0]?.textContent).toContain("not reachable");
    expect(rows[0]?.textContent).toContain("5m ago");
    expect(rows[1]?.textContent).toContain("refused by policy");
    expect(rows[0]?.querySelector("span[title]")?.getAttribute("title")).toBe(
      "code-0000-0000-4000-8000-00000000000a",
    );
  });

  it("counts the refusals it does not list from the host's total, not from the few it was sent", () => {
    const refused = (id: number) => ({
      messageId: `10000000-0000-4000-8000-0000000000${String(10 + id)}` as never,
      senderThreadId: "code-0000-0000-4000-8000-00000000000a" as never,
      recipientThreadId: `code-0000-0000-4000-8000-0000000000${String(10 + id)}` as never,
      state: "refused" as const,
      refuseReason: "policy" as const,
      occurredAt: new Date().toISOString() as never,
    });
    render(
      <AgentMessagingFactsRow
        client={undefined}
        facts={{ ...facts, refused: 40, recent: [0, 1, 2, 3, 4, 5, 6].map(refused) }}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText("35 more refusals")).toBeVisible();
  });

  it("shows no refusal list while nothing was refused", () => {
    render(
      <AgentMessagingFactsRow
        client={undefined}
        facts={{ ...facts, refused: 0, recent: [{ ...facts.recent[0]!, state: "delivered" }] }}
      />,
    );
    expect(screen.queryByLabelText("Refused agent messages")).toBeNull();
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
