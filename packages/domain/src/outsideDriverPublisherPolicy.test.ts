import { describe, expect, it } from "vitest";
import {
  decideOutsideDriverNewPublisher,
  outsideDriverPublisherPinAtTrust,
  outsideDriverUpdateKeepsTrust,
  outsideDriverPublisherStanding,
  sameExtensionSource,
  unsignedUpdateKeepsApprovals,
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

  it("keeps an unsigned package's approvals across an update from the source the person trusted, and only then", () => {
    const kept = {
      trusted: true,
      pinned: undefined,
      previous: undefined,
      updated: undefined,
      sameSource: true,
      capabilitiesWidened: false,
    };
    expect(unsignedUpdateKeepsApprovals(kept)).toBe(true);
    expect(unsignedUpdateKeepsApprovals({ ...kept, sameSource: false })).toBe(false);
    expect(unsignedUpdateKeepsApprovals({ ...kept, trusted: false })).toBe(false);
    expect(unsignedUpdateKeepsApprovals({ ...kept, capabilitiesWidened: true })).toBe(false);
    // Where a key exists, the key decides: a signed package that loses its
    // signature, or gains one nobody pinned, asks again.
    expect(unsignedUpdateKeepsApprovals({ ...kept, pinned: first })).toBe(false);
    expect(unsignedUpdateKeepsApprovals({ ...kept, previous: first })).toBe(false);
    expect(unsignedUpdateKeepsApprovals({ ...kept, updated: first })).toBe(false);
  });

  it("reads a source as the same only at the same folder, catalog entry or registry package", () => {
    const folder = { source: { kind: "local-folder", sourceRef: "local:a" } } as const;
    expect(sameExtensionSource(folder, { source: { ...folder.source } })).toBe(true);
    expect(
      sameExtensionSource(folder, { source: { kind: "local-folder", sourceRef: "local:b" } }),
    ).toBe(false);
    expect(
      sameExtensionSource(folder, { source: { kind: "plugin-package", sourceRef: "local:a" } }),
    ).toBe(false);
    const entry = { source: { kind: "catalog", catalogId: "octant", entryId: "notes" } } as const;
    expect(sameExtensionSource(entry, { source: { ...entry.source } })).toBe(true);
    expect(
      sameExtensionSource(entry, { source: { ...entry.source, entryId: "other" } }),
    ).toBe(false);
    const npm = { packageName: "notes", registry: "https://registry.example/" };
    const fromNpm = { source: { kind: "plugin-package", sourceRef: "npm:notes" }, npm } as const;
    expect(sameExtensionSource(fromNpm, { ...fromNpm, npm: { ...npm } })).toBe(true);
    expect(
      sameExtensionSource(fromNpm, {
        ...fromNpm,
        npm: { ...npm, registry: "https://mirror.example/" },
      }),
    ).toBe(false);
    expect(sameExtensionSource(fromNpm, { source: fromNpm.source })).toBe(false);
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
