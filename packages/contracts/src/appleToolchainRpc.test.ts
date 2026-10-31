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
    expect(
      rpc!.decodeAppleArtifactRequest({
        kind: "apple-artifact-request",
        authority,
        ...scope,
        reference: "apple-screenshot-1",
      }),
    ).toMatchObject({ kind: "apple-artifact-request", reference: "apple-screenshot-1" });
    expect(() =>
      rpc!.decodeAppleArtifactRequest({
        kind: "apple-artifact-request",
        authority,
        ...scope,
        reference: "../escape",
      }),
    ).toThrow();
  });

  it("decodes a discovery request that names the project by absolute path and still refuses traversal", async () => {
    const { decodeAppleRpcEnvelope } = await import("./appleToolchainRpc");
    const request = {
      actionId: "50000000-0000-4000-8000-000000000006",
      correlationId: "50000000-0000-4000-8000-000000000007",
      authority: {
        hostId: "50000000-0000-4000-8000-000000000001",
        mode: "code",
        projectId: "50000000-0000-4000-8000-000000000002",
        providerInstanceId: "50000000-0000-4000-8000-000000000003",
        extension: { kind: "core" },
      },
      threadId: "50000000-0000-4000-8000-000000000004",
      checkoutId: "50000000-0000-4000-8000-000000000005",
    } as const;
    const decode = (projectPath: string) =>
      decodeAppleRpcEnvelope({
        kind: "apple-discovery-request",
        request: { ...request, projectPath },
      });
    expect(decode("/Users/me/repo/App/App.xcodeproj")).toMatchObject({
      request: { projectPath: "/Users/me/repo/App/App.xcodeproj" },
    });
    expect(() => decode("/Users/me/../etc/App.xcodeproj")).toThrow();
    expect(() => decode("C:\\repo\\App.xcodeproj")).toThrow();
  });
});
