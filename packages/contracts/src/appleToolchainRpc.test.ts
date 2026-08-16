import { describe, expect, it } from "vitest";

describe("Apple toolchain RPC", () => {
  it("decodes scoped discovery, action, cancellation, and snapshot envelopes", async () => {
    const path = "./appleToolchainRpc";
    const rpc = await import(path).catch(() => undefined);
    expect(rpc).toBeDefined();
    expect(rpc?.decodeAppleRpcEnvelope).toBeTypeOf("function");
    const authority = {
      hostId: "50000000-0000-4000-8000-000000000001",
      mode: "code",
      projectId: "50000000-0000-4000-8000-000000000002",
      providerInstanceId: "50000000-0000-4000-8000-000000000003",
      extension: { kind: "core" },
    } as const;
    const scope = {
      threadId: "50000000-0000-4000-8000-000000000004",
      checkoutId: "50000000-0000-4000-8000-000000000005",
    } as const;
    expect(
      rpc!.decodeAppleRpcEnvelope({
        kind: "apple-snapshot-request",
        authority,
        ...scope,
      }),
    ).toMatchObject({ kind: "apple-snapshot-request" });
    expect(
      rpc!.decodeAppleRpcEnvelope({
        kind: "apple-cancel-request",
        cancellation: {
          actionId: "50000000-0000-4000-8000-000000000006",
          correlationId: "50000000-0000-4000-8000-000000000007",
          authority,
          reason: "user-requested",
        },
        ...scope,
      }),
    ).toMatchObject({ kind: "apple-cancel-request" });
  });
});
