import { describe, expect, it } from "vitest";
import {
  DESKTOP_ARTIFACT_MAXIMUM_BYTES,
  decodeDesktopArtifactSent,
  decodeDesktopLeaseRequested,
  decodeDesktopLeaseTransitioned,
  decodeDesktopRecipe,
} from "./desktopLease";

const leaseId = "d1000000-0000-4000-8000-000000000001";
const threadId = "d1000000-0000-4000-8000-000000000002";
const hostTag = "d1000000-0000-4000-8000-000000000003";
const credentialRef = "d1000000-0000-4000-8000-000000000004";

const recipe = {
  providerId: "host-local",
  screen: { width: 1280, height: 800 },
  network: "none",
  leaseMinutes: 30,
  maximumLeaseMinutes: 240,
  idleMinutes: 15,
} as const;

const requested = {
  leaseId,
  owner: { mode: "code", threadId },
  providerId: "cloud.example",
  locality: "cloud",
  billed: true,
  hostTag,
  credentialRef,
  network: "none",
  expiresAt: "2026-10-26T12:30:00.000Z",
  maximumExpiresAt: "2026-10-26T16:00:00.000Z",
  idleMinutes: 15,
} as const;

describe("desktop lease contract", () => {
  it("refuses a recipe whose lease outlives four hours or starts beyond its own maximum", () => {
    expect(decodeDesktopRecipe(recipe).maximumLeaseMinutes).toBe(240);
    expect(() => decodeDesktopRecipe({ ...recipe, maximumLeaseMinutes: 241 })).toThrow();
    expect(() =>
      decodeDesktopRecipe({ ...recipe, leaseMinutes: 60, maximumLeaseMinutes: 45 }),
    ).toThrow();
  });

  it("never lets a Chat thread own a lease", () => {
    expect(decodeDesktopLeaseRequested(requested).owner.mode).toBe("code");
    expect(() =>
      decodeDesktopLeaseRequested({ ...requested, owner: { mode: "chat", threadId } }),
    ).toThrow();
  });

  it("journals the credential reference and refuses credential material", () => {
    expect(decodeDesktopLeaseRequested(requested).credentialRef).toBe(credentialRef);
    expect(() => decodeDesktopLeaseRequested({ ...requested, apiKey: "sk-live" })).toThrow();
  });

  it("attributes a release a person asked for while teardown records the transition", () => {
    const transitioned = decodeDesktopLeaseTransitioned({
      leaseId,
      owner: { mode: "work", threadId },
      providerId: "host-local",
      from: "ready",
      to: "releasing",
      endReason: "released",
      requestedBy: { kind: "local-user", actorId: "d1000000-0000-4000-8000-000000000005" },
    });
    expect(transitioned.requestedBy?.kind).toBe("local-user");
  });

  it("journals a transfer's path, size, and SHA-256 and nothing of its contents", () => {
    const sent = {
      leaseId,
      owner: { mode: "code", threadId },
      providerId: "host-local",
      path: "dist/app.AppImage",
      name: "app.AppImage",
      size: 1_024,
      sha256: "a".repeat(64),
    } as const;
    expect(decodeDesktopArtifactSent(sent).sha256).toBe("a".repeat(64));
    expect(() => decodeDesktopArtifactSent({ ...sent, bytes: "AAAA" })).toThrow();
    expect(() => decodeDesktopArtifactSent({ ...sent, sha256: "A".repeat(64) })).toThrow();
    expect(() => decodeDesktopArtifactSent({ ...sent, name: "dist/app" })).toThrow();
    expect(() =>
      decodeDesktopArtifactSent({ ...sent, size: DESKTOP_ARTIFACT_MAXIMUM_BYTES + 1 }),
    ).toThrow();
  });
});
