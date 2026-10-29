import { describe, expect, it } from "vitest";
import {
  decodeHubAutoApplyRequest,
  decodeHubOfferBody,
  decodeHubOfferDelivery,
  looksLikeSecret,
} from "./hubProvision";

const endpoint = {
  kind: "model-endpoint",
  family: "openai-compatible",
  displayName: "Home gateway",
  baseUrl: "https://gateway.example.test/v1",
  protocol: "auto",
  authentication: "key",
  manualModelIds: ["model-a"],
} as const;

const profile = {
  kind: "agent-profile",
  displayName: "Reviewer",
  approvedSkillIds: [],
  toolConstraints: [],
  modelConstraints: [],
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "current-session",
  compatibleModes: ["work"],
} as const;

describe("a hub offer", () => {
  it("accepts an endpoint row and a profile that carry no secret", () => {
    expect(decodeHubOfferBody(endpoint)).toMatchObject({ kind: "model-endpoint" });
    expect(decodeHubOfferBody(profile)).toMatchObject({ kind: "agent-profile" });
  });

  it("refuses an endpoint row with any field a key could ride in", () => {
    for (const extra of [
      { apiKey: "anything" },
      { headers: { authorization: "x" } },
      { credentialRef: "broker://item" },
    ]) {
      expect(() => decodeHubOfferBody({ ...endpoint, ...extra })).toThrow();
    }
    for (const baseUrl of [
      "https://user:pass@gateway.example.test/v1",
      "https://gateway.example.test/v1?key=abc",
      "https://gateway.example.test/v1#token",
      "http://gateway.example.test/v1",
    ]) {
      expect(() => decodeHubOfferBody({ ...endpoint, baseUrl })).toThrow();
    }
  });

  it("refuses a profile whose text looks like a credential or that names an id or scope", () => {
    expect(() =>
      decodeHubOfferBody({ ...profile, instructions: "Call it with sk-abcdefghijklmnopqrstuv01." }),
    ).toThrow();
    expect(() => decodeHubOfferBody({ ...profile, secretRef: "keychain:item" })).toThrow();
    expect(() => decodeHubOfferBody({ ...profile, scope: { scopeKind: "user" } })).toThrow();
  });

  it("recognises the shapes of keys without flagging ordinary prose", () => {
    expect(looksLikeSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(true);
    expect(looksLikeSecret("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(looksLikeSecret("Review the change and list the risks.")).toBe(false);
  });

  it("refuses a delivery with a field the offer does not define", () => {
    expect(() =>
      decodeHubOfferDelivery({
        offerId: "55555555-5555-4555-8555-555555555555",
        offer: endpoint,
        token: "x",
      }),
    ).toThrow();
  });

  it("lets only an update channel, a plugin, and a profile apply on arrival", () => {
    expect(decodeHubAutoApplyRequest({ kind: "plugin", enabled: true })).toBeDefined();
    expect(() => decodeHubAutoApplyRequest({ kind: "routine", enabled: true })).toThrow();
    expect(() => decodeHubAutoApplyRequest({ kind: "model-endpoint", enabled: true })).toThrow();
  });
});
