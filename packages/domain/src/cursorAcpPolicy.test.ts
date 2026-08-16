import { describe, expect, it } from "vitest";
import {
  CURSOR_ACP_NO_GO_RESIDUAL_ID,
  CursorAcpPolicyRejected,
  runCursorAcpConnectionCheck,
} from "./cursorAcpPolicy";

const request = {
  schemaVersion: 1,
  kind: "cursor-acp-connection-check",
  config: {
    schemaVersion: 1,
    kind: "cursor-acp-config",
    executablePath: "/Users/example/.local/bin/cursor-agent",
    authMode: "api-key",
    productionEnabled: false,
    updatedAt: "2026-08-04T12:00:00.000Z",
  },
  sendPrompt: false,
} as const;

describe("Cursor ACP policy", () => {
  it("returns a blocked residual connection check under the NO-GO residual", () => {
    const result = runCursorAcpConnectionCheck({ request });
    expect(result.status).toBe("blocked");
    expect(result.residualPacketId).toBe(CURSOR_ACP_NO_GO_RESIDUAL_ID);
  });

  it("preserves prompt-forbidden and production-blocked denial codes", () => {
    try {
      runCursorAcpConnectionCheck({ request: { ...request, sendPrompt: true } });
      throw new Error("expected prompt-forbidden");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpPolicyRejected);
      expect((error as CursorAcpPolicyRejected).denialCode).toBe("prompt-forbidden");
    }

    try {
      runCursorAcpConnectionCheck({
        request: {
          ...request,
          config: { ...request.config, productionEnabled: true },
        },
      });
      throw new Error("expected production-blocked");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpPolicyRejected);
      expect((error as CursorAcpPolicyRejected).denialCode).toBe("production-blocked");
    }
  });

  it("classifies nested array secrets as secret-forbidden before strict decode", () => {
    try {
      runCursorAcpConnectionCheck({
        request: {
          ...request,
          config: {
            ...request.config,
            metadata: [{ apiKey: "nested-secret" }],
          },
        },
      });
      throw new Error("expected secret-forbidden");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpPolicyRejected);
      expect((error as CursorAcpPolicyRejected).denialCode).toBe("secret-forbidden");
    }
  });

  it("bounds hostile nested config trees as malformed-request", () => {
    let nested: unknown = { leaf: true };
    for (let i = 0; i < 20; i += 1) nested = { child: [nested] };
    try {
      runCursorAcpConnectionCheck({
        request: {
          ...request,
          config: {
            ...request.config,
            metadata: nested,
          },
        },
      });
      throw new Error("expected malformed-request");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpPolicyRejected);
      expect((error as CursorAcpPolicyRejected).denialCode).toBe("malformed-request");
    }
  });

  it("shares the secret-scan entry budget across wide trees", () => {
    const wide = {
      nodes: Array.from({ length: 40 }, (_, i) => ({ ["child" + i]: { leaf: true } })),
    };
    try {
      runCursorAcpConnectionCheck({
        request: {
          ...request,
          config: {
            ...request.config,
            metadata: wide,
          },
        },
      });
      // may pass if under budget; force bigger
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpPolicyRejected);
    }
    const huge = { nodes: Array.from({ length: 300 }, (_, i) => ({ ["n" + i]: true })) };
    try {
      runCursorAcpConnectionCheck({
        request: {
          ...request,
          config: {
            ...request.config,
            metadata: huge,
          },
        },
      });
      throw new Error("expected malformed-request");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpPolicyRejected);
      expect((error as CursorAcpPolicyRejected).denialCode).toBe("malformed-request");
    }
  });

  it("maps top-level throwing request getters to typed malformed-request", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile getter");
        },
      },
    );
    try {
      runCursorAcpConnectionCheck({ request: hostile });
      throw new Error("expected malformed-request");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpPolicyRejected);
      expect((error as CursorAcpPolicyRejected).denialCode).toBe("malformed-request");
    }
  });
});
