import { describe, expect, it } from "vitest";
import {
  decodeIntegrationAuthenticationCommand,
  decodeIntegrationAuthenticationSnapshot,
  decodeIntegrationCommand,
  decodeIntegrationObservation,
} from "./integration";

describe("integration contract", () => {
  it("decodes a ready authentication snapshot", () => {
    const snapshot = decodeIntegrationAuthenticationSnapshot({
      state: "ready",
      account: { login: "alice", source: "host", scopes: ["read", "write"] },
      capabilities: [
        { operationId: "list-repositories", available: true },
        { operationId: "create-pull-request", available: false, remediation: "missing scope" },
      ],
    });
    expect(snapshot.state).toBe("ready");
    expect(snapshot.account?.login).toBe("alice");
    expect(snapshot.capabilities).toHaveLength(2);
  });

  it("decodes a snapshot with an authentication interaction", () => {
    const snapshot = decodeIntegrationAuthenticationSnapshot({
      state: "unauthorized",
      capabilities: [],
      interaction: {
        kind: "device-flow",
        verificationUri: "https://example.com/device",
        userCode: "ABCD-1234",
      },
    });
    expect(snapshot.interaction?.kind).toBe("device-flow");
    expect(snapshot.interaction?.userCode).toBe("ABCD-1234");
  });

  it("decodes authentication commands", () => {
    expect(decodeIntegrationAuthenticationCommand({ kind: "setup" }).kind).toBe("setup");
    expect(decodeIntegrationAuthenticationCommand({ kind: "refresh" }).kind).toBe("refresh");
    expect(decodeIntegrationAuthenticationCommand({ kind: "logout" }).kind).toBe("logout");
  });

  it("decodes an operation command envelope", () => {
    const command = decodeIntegrationCommand({
      kind: "operation",
      operationId: "list-issues",
      input: { projectId: "123" },
    });
    expect(command.kind).toBe("operation");
    if (command.kind !== "operation") return;
    expect(command.operationId).toBe("list-issues");
  });

  it("decodes an authentication observation envelope", () => {
    const observation = decodeIntegrationObservation({
      kind: "authentication",
      snapshot: { state: "ready", capabilities: [] },
    });
    expect(observation.kind).toBe("authentication");
  });

  it("rejects an unknown authentication state", () => {
    expect(() =>
      decodeIntegrationAuthenticationSnapshot({
        state: "unknown-state",
        capabilities: [],
      }),
    ).toThrow();
  });
});
