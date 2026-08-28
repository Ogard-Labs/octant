import { describe, expect, it } from "vitest";
import { MAX_TRACKER_REFERENCES_PER_RESOLUTION } from "@octant/contracts";
import { recognizeTrackerReferences } from "./trackerReferencePolicy";

describe("recognizeTrackerReferences", () => {
  it("recognizes an owner/name#number GitHub reference in a text run", () => {
    const text = "see octant/octant#12 and octant-labs/repo.name_1#770 please";
    expect(recognizeTrackerReferences(text)).toEqual([
      {
        start: 4,
        end: 20,
        reference: {
          patternKind: "github-issue-or-pull",
          raw: "octant/octant#12",
          owner: "octant",
          name: "octant",
          number: 12,
        },
      },
      {
        start: 25,
        end: 52,
        reference: {
          patternKind: "github-issue-or-pull",
          raw: "octant-labs/repo.name_1#770",
          owner: "octant-labs",
          name: "repo.name_1",
          number: 770,
        },
      },
    ]);
  });

  it("recognizes a tracker-key reference with or without a leading hash", () => {
    const text = "ABC-99 is the same as #ABC-99 in prose";
    expect(recognizeTrackerReferences(text)).toEqual([
      {
        start: 0,
        end: 6,
        reference: { patternKind: "tracker-key", raw: "ABC-99", key: "ABC-99" },
      },
      {
        start: 22,
        end: 29,
        reference: { patternKind: "tracker-key", raw: "#ABC-99", key: "ABC-99" },
      },
    ]);
  });

  it("does not treat a bare #number as a tracker reference because it collides with thread mentions", () => {
    expect(recognizeTrackerReferences("see #123 for the other thread")).toEqual([]);
    expect(recognizeTrackerReferences("#42")).toEqual([]);
    expect(recognizeTrackerReferences("issue#42")).toEqual([]);
    expect(recognizeTrackerReferences("look at #1 then stop")).toEqual([]);
  });

  it("does not treat an unmatched #thread token as a tracker reference", () => {
    expect(recognizeTrackerReferences("compare with #release notes")).toEqual([]);
    expect(recognizeTrackerReferences("#rele")).toEqual([]);
    expect(recognizeTrackerReferences("#[Release notes] and")).toEqual([]);
    expect(recognizeTrackerReferences("look at #ABC then #thread")).toEqual([]);
  });

  it("does not recognize a GitHub shorthand glued to a URL path or surrounding identifier", () => {
    expect(recognizeTrackerReferences("https://github.com/octant/octant#12")).toEqual([]);
    expect(recognizeTrackerReferences("prefix_octant/octant#12")).toEqual([]);
    expect(recognizeTrackerReferences("octant/octant#12x")).toEqual([]);
    expect(recognizeTrackerReferences("octant/octant#12_more")).toEqual([]);
    expect(recognizeTrackerReferences("see ./octant#12")).toEqual([]);
  });

  it("does not recognize tracker keys that are glued, too short, lowercase, or nested in a thread chip", () => {
    expect(recognizeTrackerReferences("foo-ABC-99")).toEqual([]);
    expect(recognizeTrackerReferences("see#ABC-99")).toEqual([]);
    expect(recognizeTrackerReferences("abc-99")).toEqual([]);
    expect(recognizeTrackerReferences("A-9")).toEqual([]);
    expect(recognizeTrackerReferences("ABCDEFGHIJK-1")).toEqual([]);
    expect(recognizeTrackerReferences("ABC-99_more")).toEqual([]);
    expect(recognizeTrackerReferences("#[ABC-99]")).toEqual([]);
  });

  it("recognizes a tracker-key whose numeric suffix is longer than ten digits", () => {
    expect(recognizeTrackerReferences("see ABC-12345678901 please")).toEqual([
      {
        start: 4,
        end: 19,
        reference: {
          patternKind: "tracker-key",
          raw: "ABC-12345678901",
          key: "ABC-12345678901",
        },
      },
    ]);
  });

  it("returns mixed GitHub and tracker-key spans in left-to-right order without overlapping", () => {
    const text = "ABC-99 then octant/octant#12 then #XYZ-7";
    expect(recognizeTrackerReferences(text).map((span) => span.reference.raw)).toEqual([
      "ABC-99",
      "octant/octant#12",
      "#XYZ-7",
    ]);
  });

  it("caps the recognized spans at the per-resolution bound", () => {
    const text = Array.from(
      { length: MAX_TRACKER_REFERENCES_PER_RESOLUTION + 3 },
      (_, index) => `ABC-${index + 10}`,
    ).join(" ");
    const spans = recognizeTrackerReferences(text);
    expect(spans).toHaveLength(MAX_TRACKER_REFERENCES_PER_RESOLUTION);
    expect(spans[0]?.reference).toMatchObject({ raw: "ABC-10" });
  });
});
