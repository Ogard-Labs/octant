import {
  decodeOctantHostFeaturesDocument,
  NIGHTLY_HOST_FEATURES,
} from "@octant/contracts/nightly-browser";
import { describe, expect, it } from "vitest";
import {
  hostFeaturesDocument,
  parseHostFeaturesCommand,
  readPublishedHostFeatures,
} from "./write-host-features";

describe("the host features an Octant release publishes", () => {
  it("lists the native client protocol and every brokered feature the host advertises", () => {
    const document = hostFeaturesDocument("0.2.0-candidate.20261106.81");

    expect(document).toEqual({
      schemaVersion: 1,
      octantVersion: "0.2.0-candidate.20261106.81",
      nativeClientProtocol: 1,
      hostFeatures: [...NIGHTLY_HOST_FEATURES],
    });
    expect(decodeOctantHostFeaturesDocument(JSON.parse(JSON.stringify(document)))).toEqual(
      document,
    );
  });

  it("reports a newer Octant's protocol as a mismatch rather than an unreadable document", () => {
    const current = hostFeaturesDocument("0.2.0-candidate.20261106.81");
    expect(readPublishedHostFeatures(JSON.parse(JSON.stringify(current)))).toEqual({
      status: "compatible",
      document: current,
    });
    expect(
      readPublishedHostFeatures({
        ...current,
        nativeClientProtocol: 2,
        hostFeatures: [...current.hostFeatures, "a-feature-from-later"],
      }),
    ).toEqual({ status: "protocol-mismatch", published: 2, expected: 1 });
    expect(readPublishedHostFeatures({ ...current, nativeClientProtocol: 0 })).toEqual({
      status: "unreadable",
    });
    expect(readPublishedHostFeatures("not a document")).toEqual({ status: "unreadable" });
  });

  it("is published for stable and candidate Octant only", () => {
    expect(hostFeaturesDocument("0.2.0").octantVersion).toBe("0.2.0");
    expect(() => hostFeaturesDocument("0.2.0-preview.20261106.80")).toThrow(/Octant Nightly/);
    expect(() => hostFeaturesDocument("not a version")).toThrow();
  });

  it("refuses a command without its version or output", () => {
    expect(parseHostFeaturesCommand(["--version", "0.2.0", "--out", "/tmp/x.json"])).toEqual({
      version: "0.2.0",
      out: "/tmp/x.json",
    });
    expect(() => parseHostFeaturesCommand(["--out", "/tmp/x.json"])).toThrow(/--version/);
    expect(() => parseHostFeaturesCommand(["--version", "0.2.0", "--out"])).toThrow(/--out/);
  });
});
