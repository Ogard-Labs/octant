import { describe, expect, it } from "vitest";
import {
  MAX_TRACKER_REFERENCES_PER_RESOLUTION,
  decodeTrackerReference,
  decodeTrackerReferenceResolution,
  decodeTrackerReferenceResolutionRequest,
  decodeTrackerReferenceResolutionResponse,
} from "./trackerReference";

const githubReference = {
  patternKind: "github-issue-or-pull",
  raw: "octant/octant#12",
  owner: "octant",
  name: "octant",
  number: 12,
} as const;

const trackerKeyReference = {
  patternKind: "tracker-key",
  raw: "#ABC-99",
  key: "ABC-99",
} as const;

describe("tracker reference contracts", () => {
  it("accepts a GitHub owner/name#number reference whose raw text matches the parsed identity", () => {
    expect(decodeTrackerReference(githubReference)).toEqual(githubReference);
    expect(
      decodeTrackerReference({
        patternKind: "github-issue-or-pull",
        raw: "octant-labs/repo.name_1#770",
        owner: "octant-labs",
        name: "repo.name_1",
        number: 770,
      }),
    ).toMatchObject({ owner: "octant-labs", name: "repo.name_1", number: 770 });
  });

  it("accepts a tracker-key reference with or without a leading hash, as long as raw agrees with key", () => {
    expect(decodeTrackerReference(trackerKeyReference)).toEqual(trackerKeyReference);
    expect(
      decodeTrackerReference({ patternKind: "tracker-key", raw: "ABC-99", key: "ABC-99" }),
    ).toEqual({ patternKind: "tracker-key", raw: "ABC-99", key: "ABC-99" });
  });

  it("rejects a GitHub reference whose raw text disagrees with owner, name, or number", () => {
    expect(() => decodeTrackerReference({ ...githubReference, raw: "other/octant#12" })).toThrow();
    expect(() => decodeTrackerReference({ ...githubReference, number: 99 })).toThrow();
    expect(() =>
      decodeTrackerReference({ ...githubReference, raw: "octant/octant#012" }),
    ).toThrow();
  });

  it("rejects invalid GitHub identities and tracker-key forms", () => {
    for (const owner of ["-leading", "a".repeat(40), "own/er", "own er", ""]) {
      expect(() =>
        decodeTrackerReference({
          patternKind: "github-issue-or-pull",
          raw: `${owner}/octant#1`,
          owner,
          name: "octant",
          number: 1,
        }),
      ).toThrow();
    }
    expect(() =>
      decodeTrackerReference({
        patternKind: "github-issue-or-pull",
        raw: "octant/..#1",
        owner: "octant",
        name: "..",
        number: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeTrackerReference({ ...githubReference, raw: "octant/octant#0", number: 0 }),
    ).toThrow();
    expect(() =>
      decodeTrackerReference({ patternKind: "tracker-key", raw: "abc-99", key: "abc-99" }),
    ).toThrow();
    expect(() =>
      decodeTrackerReference({ patternKind: "tracker-key", raw: "A-9", key: "A-9" }),
    ).toThrow();
    expect(() =>
      decodeTrackerReference({
        patternKind: "tracker-key",
        raw: "ABCDEFGHIJK-1",
        key: "ABCDEFGHIJK-1",
      }),
    ).toThrow();
    expect(() =>
      decodeTrackerReference({ patternKind: "tracker-key", raw: "#ABC-99", key: "XYZ-1" }),
    ).toThrow();
  });

  it("accepts a tracker-key whose numeric suffix is longer than ten digits", () => {
    expect(
      decodeTrackerReference({
        patternKind: "tracker-key",
        raw: "ABC-12345678901",
        key: "ABC-12345678901",
      }),
    ).toEqual({
      patternKind: "tracker-key",
      raw: "ABC-12345678901",
      key: "ABC-12345678901",
    });
  });

  it("rejects excess properties on a reference and on a batch request", () => {
    expect(() => decodeTrackerReference({ ...githubReference, extra: true })).toThrow();
    expect(() => decodeTrackerReference({ ...githubReference, key: "ABC-99" })).toThrow();
    expect(() => decodeTrackerReference({ ...trackerKeyReference, owner: "octant" })).toThrow();
    expect(() =>
      decodeTrackerReferenceResolutionRequest({
        references: [githubReference],
        endpoint: "/resolve",
      }),
    ).toThrow();
  });

  it("bounds a resolution request to the per-batch maximum", () => {
    expect(decodeTrackerReferenceResolutionRequest({ references: [] })).toEqual({
      references: [],
    });
    expect(
      decodeTrackerReferenceResolutionRequest({ references: [githubReference] }),
    ).toMatchObject({ references: [githubReference] });
    expect(() =>
      decodeTrackerReferenceResolutionRequest({
        references: Array.from(
          { length: MAX_TRACKER_REFERENCES_PER_RESOLUTION + 1 },
          (_, index) => ({
            patternKind: "github-issue-or-pull",
            raw: `octant/octant#${index + 1}`,
            owner: "octant",
            name: "octant",
            number: index + 1,
          }),
        ),
      }),
    ).toThrow();
  });

  it("accepts resolved issue and pull-request outcomes and rejects impossible issue states", () => {
    const issue = decodeTrackerReferenceResolution({
      status: "resolved",
      reference: githubReference,
      title: "Catalogue reads",
      url: "https://github.com/octant/octant/issues/12",
      kind: "issue",
      state: "open",
    });
    expect(issue).toMatchObject({ status: "resolved", kind: "issue", state: "open" });
    expect(
      decodeTrackerReferenceResolution({
        status: "resolved",
        reference: githubReference,
        title: "Wire the catalogue",
        url: "https://github.com/octant/octant/pull/12",
        kind: "pull-request",
        state: "merged",
      }),
    ).toMatchObject({ kind: "pull-request", state: "merged" });
    expect(() =>
      decodeTrackerReferenceResolution({
        status: "resolved",
        reference: githubReference,
        title: "Catalogue reads",
        url: "https://github.com/octant/octant/issues/12",
        kind: "issue",
        state: "merged",
      }),
    ).toThrow();
  });

  it("accepts unclaimed, unavailable, and not-found outcomes as values", () => {
    expect(
      decodeTrackerReferenceResolution({
        status: "unclaimed",
        reference: trackerKeyReference,
      }),
    ).toMatchObject({ status: "unclaimed" });
    expect(
      decodeTrackerReferenceResolution({
        status: "not-found",
        reference: githubReference,
      }),
    ).toMatchObject({ status: "not-found" });
    expect(
      decodeTrackerReferenceResolution({
        status: "unavailable",
        reference: githubReference,
        reason: "rate-limited",
        retryAfterSeconds: 90,
        remediation: "Wait and retry the read.",
      }),
    ).toMatchObject({ status: "unavailable", reason: "rate-limited" });
  });

  it("rejects excess properties and unsafe resolved payloads", () => {
    expect(() =>
      decodeTrackerReferenceResolution({
        status: "unclaimed",
        reference: trackerKeyReference,
        title: "should not leak",
      }),
    ).toThrow();
    expect(() =>
      decodeTrackerReferenceResolution({
        status: "not-found",
        reference: githubReference,
        url: "https://github.com/octant/octant/issues/12",
      }),
    ).toThrow();
    expect(() =>
      decodeTrackerReferenceResolution({
        status: "resolved",
        reference: githubReference,
        title: "Catalogue reads",
        url: "https://github.com/octant/octant/issues/12",
        kind: "issue",
        state: "open",
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      decodeTrackerReferenceResolution({
        status: "resolved",
        reference: githubReference,
        title: "Authorization: Bearer abc",
        url: "https://github.com/octant/octant/issues/12",
        kind: "issue",
        state: "open",
      }),
    ).toThrow();
    expect(() =>
      decodeTrackerReferenceResolution({
        status: "resolved",
        reference: githubReference,
        title: "Catalogue reads",
        url: "https://token@github.com/octant/octant/issues/12",
        kind: "issue",
        state: "open",
      }),
    ).toThrow();
    expect(() =>
      decodeTrackerReferenceResolution({
        status: "unavailable",
        reference: githubReference,
        reason: "rate-limited",
        retryAfterSeconds: -1,
      }),
    ).toThrow();
  });

  it("accepts a bounded response and rejects an oversize result list", () => {
    expect(
      decodeTrackerReferenceResolutionResponse({
        results: [
          { status: "unclaimed", reference: trackerKeyReference },
          { status: "not-found", reference: githubReference },
        ],
      }),
    ).toMatchObject({ results: [{ status: "unclaimed" }, { status: "not-found" }] });
    expect(() =>
      decodeTrackerReferenceResolutionResponse({
        results: Array.from({ length: MAX_TRACKER_REFERENCES_PER_RESOLUTION + 1 }, () => ({
          status: "unclaimed",
          reference: trackerKeyReference,
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeTrackerReferenceResolutionResponse({
        results: [],
        cursor: "next",
      }),
    ).toThrow();
  });
});
