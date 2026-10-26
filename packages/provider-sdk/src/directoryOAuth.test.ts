import { decodeDirectoryClientId, decodeDirectoryTenantId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  encodeDirectoryOAuthCredential,
  readDirectoryOAuthCredential,
  type DirectoryOAuthCredential,
} from "./directoryOAuth";
import {
  encodeSubscriptionOAuthCredential,
  readSubscriptionOAuthCredential,
} from "./subscriptionOAuth";

const pointer: DirectoryOAuthCredential = {
  kind: "directory-oauth",
  credentialRef: "7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a",
  tenantId: decodeDirectoryTenantId("6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f"),
  clientId: decodeDirectoryClientId("0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d"),
  audience: "https://models.example.test",
  endpointOrigin: "https://fixture.models.example.test",
  accountLabel: "person@contoso.example",
};

describe("directory-oauth credential pointer", () => {
  it("round-trips a pointer that names only references and its binding", () => {
    const stored = encodeDirectoryOAuthCredential(pointer);
    expect(readDirectoryOAuthCredential(stored)).toEqual(pointer);
    expect(stored).not.toMatch(/token|secret/i);
  });

  it("does not read an API key, another kind's pointer, or a pointer that could bind loosely", () => {
    expect(readDirectoryOAuthCredential("sk-fixture-api-key")).toBeUndefined();
    const subscription = encodeSubscriptionOAuthCredential({
      kind: "subscription-oauth",
      credentialRef: pointer.credentialRef,
      descriptorId: "sample-http",
      accountLabel: "Fixture account",
    });
    expect(readDirectoryOAuthCredential(subscription)).toBeUndefined();
    expect(
      readSubscriptionOAuthCredential(encodeDirectoryOAuthCredential(pointer)),
    ).toBeUndefined();

    const tampered = (change: Record<string, unknown>) =>
      readDirectoryOAuthCredential(JSON.stringify({ ...pointer, ...change }));
    expect(tampered({ tenantId: "common" })).toBeUndefined();
    expect(tampered({ clientId: "octant" })).toBeUndefined();
    expect(tampered({ credentialRef: "../grants/other" })).toBeUndefined();
    // The origin is the canonical origin of an https endpoint, nothing more:
    // a path, a plain-http origin, or embedded credentials could widen it.
    expect(tampered({ endpointOrigin: "https://fixture.models.example.test/v1" })).toBeUndefined();
    expect(tampered({ endpointOrigin: "http://fixture.models.example.test" })).toBeUndefined();
    expect(
      tampered({ endpointOrigin: "https://user@fixture.models.example.test" }),
    ).toBeUndefined();
    expect(tampered({ audience: "https://models.example.test/?resource=other" })).toBeUndefined();
    // A pointer never carries token material.
    expect(tampered({ accessToken: "fixture" })).toBeUndefined();
    expect(tampered({ refreshToken: "fixture" })).toBeUndefined();
  });
});
