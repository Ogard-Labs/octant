import { describe, expect, it } from "vitest";
import {
  decideOutsideDriverNewPublisher,
  outsideDriverPublisherPinAtTrust,
  outsideDriverUpdateKeepsTrust,
  outsideDriverPublisherStanding,
} from "./outsideDriverPublisherPolicy";

const first = `ed25519:${"a".repeat(64)}`;
const second = `ed25519:${"b".repeat(64)}`;

describe("outside driver publisher pinning", () => {
  it("pins the signing key at first trust and never replaces a pin by trusting", () => {
    expect(outsideDriverPublisherPinAtTrust(undefined, first)).toBe(first);
    expect(outsideDriverPublisherPinAtTrust(undefined, undefined)).toBeUndefined();
    expect(outsideDriverPublisherPinAtTrust(first, second)).toBeUndefined();
  });

  it("holds a version signed by another key, or by none, once a key is pinned", () => {
    expect(outsideDriverPublisherStanding(undefined, first).kind).toBe("unpinned");
    expect(outsideDriverPublisherStanding(first, first).kind).toBe("pinned-publisher");
    expect(outsideDriverPublisherStanding(first, second).kind).toBe("publisher-changed");
    expect(outsideDriverPublisherStanding(first, undefined).kind).toBe("publisher-changed");
  });

  it("keeps trust across an update the pinned key signed, and asks again for a new or missing key", () => {
    const trusted = { trusted: true, pinned: first, capabilitiesWidened: false };
    expect(outsideDriverUpdateKeepsTrust({ ...trusted, updated: first })).toBe(true);
    expect(outsideDriverUpdateKeepsTrust({ ...trusted, updated: second })).toBe(false);
    expect(outsideDriverUpdateKeepsTrust({ ...trusted, updated: undefined })).toBe(false);
    expect(
      outsideDriverUpdateKeepsTrust({ ...trusted, pinned: undefined, updated: undefined }),
    ).toBe(false);
  });

  it("does not give an update trust the package did not have, or carry it over widened capabilities", () => {
    expect(
      outsideDriverUpdateKeepsTrust({
        trusted: false,
        pinned: first,
        updated: first,
        capabilitiesWidened: false,
      }),
    ).toBe(false);
    expect(
      outsideDriverUpdateKeepsTrust({
        trusted: true,
        pinned: first,
        updated: first,
        capabilitiesWidened: true,
      }),
    ).toBe(false);
  });

  it("re-trusts a new publisher only for a held, signed version whose key the person confirmed", () => {
    expect(
      decideOutsideDriverNewPublisher({ pinned: first, selected: second, confirmed: second }),
    ).toEqual({ kind: "replace", previous: first, next: second });
    expect(
      decideOutsideDriverNewPublisher({ pinned: first, selected: second, confirmed: first }),
    ).toEqual({ kind: "refused", reason: "key-mismatch" });
    expect(
      decideOutsideDriverNewPublisher({ pinned: first, selected: first, confirmed: first }),
    ).toEqual({ kind: "refused", reason: "not-held" });
    expect(
      decideOutsideDriverNewPublisher({ pinned: undefined, selected: second, confirmed: second }),
    ).toEqual({ kind: "refused", reason: "not-held" });
    expect(
      decideOutsideDriverNewPublisher({ pinned: first, selected: undefined, confirmed: second }),
    ).toEqual({ kind: "refused", reason: "unsigned" });
  });
});
