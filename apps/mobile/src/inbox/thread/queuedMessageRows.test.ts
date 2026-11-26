import { describe, expect, it } from "vitest";
import { queuedMessageRows } from "./queuedMessageRows";

const item = (overrides: Record<string, unknown>) => ({
  messageId: "00000000-0000-4000-8000-000000000301",
  status: "queued",
  revision: 1,
  createdAt: "2026-11-26T09:00:00.000Z",
  payload: { mode: "work", prompt: "Also update the docs" },
  ...overrides,
});

describe("the phone's queued messages", () => {
  it("lists each waiting message with its words, and only a waiting one can change", () => {
    const rows = queuedMessageRows([
      item({}),
      item({ messageId: "00000000-0000-4000-8000-000000000302", status: "dispatching" }),
      item({ messageId: "00000000-0000-4000-8000-000000000303", steering: true }),
      item({ messageId: "00000000-0000-4000-8000-000000000304", payload: undefined }),
    ] as never);
    expect(rows.map((row) => [row.text, row.changeable])).toEqual([
      ["Also update the docs", true],
      ["Also update the docs", false],
      ["Also update the docs", false],
      ["The host no longer holds this message's words.", false],
    ]);
  });
});
