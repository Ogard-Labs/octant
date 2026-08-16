import { describe, expect, it } from "vitest";
import {
  decodeCursorAcpConfig,
  decodeCursorAcpConnectionCheckRequest,
  decodeCursorAcpConnectionCheckResult,
} from "./cursorAcp";

const config = {
  schemaVersion: 1,
  kind: "cursor-acp-config",
  executablePath: "/Users/example/.local/bin/cursor-agent",
  authMode: "subscription",
  productionEnabled: false,
  updatedAt: "2026-08-04T12:00:00.000Z",
} as const;

describe("Cursor ACP contracts", () => {
  it("round-trips non-secret config and prompt-free connection check", () => {
    expect(decodeCursorAcpConfig(config)).toEqual(config);
    expect(
      decodeCursorAcpConnectionCheckRequest({
        schemaVersion: 1,
        kind: "cursor-acp-connection-check",
        config,
        sendPrompt: false,
      }),
    ).toMatchObject({ sendPrompt: false });
  });

  it("rejects production enablement and secret-bearing fields", () => {
    expect(() => decodeCursorAcpConfig({ ...config, productionEnabled: true })).toThrow();
    expect(() => decodeCursorAcpConfig({ ...config, apiKey: "sk-test" })).toThrow();
    expect(() =>
      decodeCursorAcpConnectionCheckRequest({
        schemaVersion: 1,
        kind: "cursor-acp-connection-check",
        config,
        sendPrompt: true,
      }),
    ).toThrow();
  });

  it("accepts a blocked connection-check residual result", () => {
    expect(
      decodeCursorAcpConnectionCheckResult({
        schemaVersion: 1,
        kind: "cursor-acp-connection-check-result",
        status: "blocked",
        capabilities: [],
        residualPacketId: "cursor-acp-no-go",
        message: "Cursor ACP remains fail-closed after the compatibility-probe NO-GO residual.",
      }),
    ).toMatchObject({ status: "blocked" });
  });
});
