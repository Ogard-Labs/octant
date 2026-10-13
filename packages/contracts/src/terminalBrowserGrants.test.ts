import { describe, expect, it } from "vitest";
import { decodeCodeOperationCommand, decodeCodeOperationResult } from "./codeOperations";
import { decodeProjectTerminalCommand } from "./projectTerminals";
import {
  decodeTerminalBrowserGrantIssued,
  decodeTerminalBrowserGrantOutcome,
  decodeTerminalBrowserGrantRevoked,
} from "./terminalBrowserGrants";

const ids = {
  operation: "10000000-0000-4000-8000-000000000001",
  thread: "20000000-0000-4000-8000-000000000001",
  checkout: "30000000-0000-4000-8000-000000000001",
  terminal: "40000000-0000-4000-8000-000000000001",
  grant: "50000000-0000-4000-8000-000000000001",
  window: "60000000-0000-4000-8000-000000000001",
  project: "70000000-0000-4000-8000-000000000001",
} as const;
const scope = {
  operationId: ids.operation,
  threadId: ids.thread,
  checkoutId: ids.checkout,
} as const;
const at = "2026-10-13T08:00:00.000Z";

describe("terminal Browser grant contracts", () => {
  it("lets a window start a thread terminal with the grant on and switch a live grant off", () => {
    const start = {
      kind: "start-terminal",
      ...scope,
      terminalId: ids.terminal,
      columns: 80,
      rows: 24,
      credentialRefs: [],
      browserGrant: "on",
    } as const;
    expect(decodeCodeOperationCommand(start)).toEqual(start);
    const off = { kind: "revoke-terminal-browser-grant", ...scope, terminalId: ids.terminal };
    expect(decodeCodeOperationCommand(off)).toEqual(off);
  });

  it("refuses a grant that is not exactly on, and gives the Project terminal no way to ask", () => {
    for (const browserGrant of ["off", true, "ON"]) {
      expect(() =>
        decodeCodeOperationCommand({
          kind: "start-terminal",
          ...scope,
          terminalId: ids.terminal,
          columns: 80,
          rows: 24,
          credentialRefs: [],
          browserGrant,
        }),
      ).toThrow();
    }
    expect(() =>
      decodeProjectTerminalCommand({
        kind: "start",
        projectId: ids.project,
        terminalId: ids.terminal,
        columns: 80,
        rows: 24,
        browserGrant: "on",
      }),
    ).toThrow();
  });

  it("carries a granted, refused, and revoked outcome on a terminal state and nothing secret", () => {
    const grant = { grantId: ids.grant, threadId: ids.thread, terminalId: ids.terminal };
    const outcomes = [
      { status: "granted", ...grant, issuedAt: at },
      { status: "refused", reason: "not-local-window" },
      { status: "revoked", ...grant, reason: "switched-off", revokedAt: at },
    ] as const;
    for (const browserGrant of outcomes) {
      expect(decodeTerminalBrowserGrantOutcome(browserGrant)).toEqual(browserGrant);
      const result = {
        kind: "terminal-state",
        operationId: ids.operation,
        terminalId: ids.terminal,
        state: "running",
        browserGrant,
      } as const;
      expect(decodeCodeOperationResult(result)).toEqual(result);
    }
    expect(() =>
      decodeTerminalBrowserGrantOutcome({
        status: "granted",
        ...grant,
        issuedAt: at,
        token: "secret",
      }),
    ).toThrow();
    expect(() =>
      decodeTerminalBrowserGrantOutcome({ status: "refused", reason: "because" }),
    ).toThrow();
  });

  it("records a grant being issued and revoked without a token or an address", () => {
    const grant = { grantId: ids.grant, threadId: ids.thread, terminalId: ids.terminal };
    const issued = {
      kind: "terminal-browser-grant-issued",
      ...grant,
      windowId: ids.window,
      issuedAt: at,
    };
    const revoked = {
      kind: "terminal-browser-grant-revoked",
      ...grant,
      reason: "thread-archived",
      revokedAt: at,
    };
    expect(decodeTerminalBrowserGrantIssued(issued)).toEqual(issued);
    expect(decodeTerminalBrowserGrantRevoked(revoked)).toEqual(revoked);
    expect(() =>
      decodeTerminalBrowserGrantIssued({ ...issued, url: "http://127.0.0.1" }),
    ).toThrow();
    expect(() => decodeTerminalBrowserGrantRevoked({ ...revoked, token: "x" })).toThrow();
  });
});
