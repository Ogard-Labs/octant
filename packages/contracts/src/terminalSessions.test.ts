import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  TerminalSessionImportRequest,
  decodeImportedTerminalSession,
  decodeTerminalSessionListRequest,
} from "./terminalSessions";

const request = { provider: "codex", sessionId: "019f6f43-f063-7df2-8216-515b7f7bfe9a" };

describe("terminal session continuity", () => {
  it("distinguishes a requested native adoption from an explicit text handoff without accepting source paths", () => {
    const decode = Schema.decodeUnknownSync(TerminalSessionImportRequest);
    expect(decode({ ...request, continuation: "native" }).continuation).toBe("native");
    expect(decode({ ...request, continuation: "text-handoff" }).continuation).toBe("text-handoff");
    expect(() => decode({ ...request, folder: "/other/project" })).toThrow();
    expect(() =>
      decodeTerminalSessionListRequest({
        projectId: "11111111-1111-4111-8111-111111111111",
        folder: "/other/project",
      }),
    ).toThrow();
  });
  it("keeps older imported snapshots readable while new receipts cannot claim native adoption", () => {
    const history = {
      ...request,
      title: "Read-only history",
      updatedAt: "2026-11-06T00:00:00.000Z",
      importedAt: "2026-11-06T00:00:00.000Z",
      entries: [{ role: "user", text: "Continue the task" }],
      truncated: false,
    };
    expect(decodeImportedTerminalSession(history).continuity).toBeUndefined();
    expect(() =>
      decodeImportedTerminalSession({
        ...history,
        continuity: { kind: "native", native: "supported", reason: "account-binding-unavailable" },
      }),
    ).toThrow();
  });
});
