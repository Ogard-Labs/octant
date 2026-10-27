import {
  decodeDirectoryClientId,
  decodeDirectoryIssuer,
  decodeDirectoryIssuerClientId,
  decodeDirectoryResourceScope,
  decodeDirectoryTenantId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  encodeDirectoryOAuthCredential,
  readDirectoryOAuthCredential,
  sameDirectoryOAuthBinding,
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

  it("round-trips a gateway pointer bound to its own issuer and scope, and never reads it half one kind and half the other", () => {
    const gateway: DirectoryOAuthCredential = {
      kind: "directory-oauth",
      credentialRef: pointer.credentialRef,
      issuer: decodeDirectoryIssuer("https://login.example.test/oauth2/gateway"),
      clientId: decodeDirectoryIssuerClientId("0oa1octantDesktop"),
      scope: decodeDirectoryResourceScope("gateway.models"),
      endpointOrigin: "https://llm.example.test",
      accountLabel: "person@example.test",
    };
    const stored = encodeDirectoryOAuthCredential(gateway);
    expect(readDirectoryOAuthCredential(stored)).toEqual(gateway);
    expect(stored).not.toMatch(/token|secret/i);

    const tampered = (change: Record<string, unknown>) =>
      readDirectoryOAuthCredential(JSON.stringify({ ...gateway, ...change }));
    expect(tampered({ issuer: "http://login.example.test" })).toBeUndefined();
    expect(tampered({ scope: "openid" })).toBeUndefined();
    expect(tampered({ clientId: "a/b" })).toBeUndefined();
    // A pointer naming both an issuer and a tenant could be compared as
    // either, so it is neither.
    expect(tampered({ tenantId: String(pointer.tenantId) })).toBeUndefined();
    expect(tampered({ audience: pointer.audience })).toBeUndefined();
  });

  it("compares a tenant binding and an issuer binding as different, whatever their shared fields", () => {
    const tenant = {
      tenantId: pointer.tenantId,
      clientId: pointer.clientId,
      audience: pointer.audience,
      endpointOrigin: pointer.endpointOrigin,
    };
    const issuer = {
      issuer: decodeDirectoryIssuer("https://login.example.test"),
      clientId: decodeDirectoryIssuerClientId(String(pointer.clientId)),
      scope: decodeDirectoryResourceScope("gateway.models"),
      endpointOrigin: pointer.endpointOrigin,
    };
    expect(sameDirectoryOAuthBinding(tenant, { ...tenant })).toBe(true);
    expect(sameDirectoryOAuthBinding(issuer, { ...issuer })).toBe(true);
    expect(sameDirectoryOAuthBinding(tenant, issuer)).toBe(false);
    expect(sameDirectoryOAuthBinding(issuer, tenant)).toBe(false);
    expect(
      sameDirectoryOAuthBinding(issuer, {
        ...issuer,
        scope: decodeDirectoryResourceScope("gateway.admin"),
      }),
    ).toBe(false);
  });
});
