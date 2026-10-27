import { describe, expect, it } from "vitest";
import { parsePropertyList } from "./appleSigning";

describe("provisioning property lists", () => {
  it("skips a comment and never reads the elements inside it", () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "x"><plist version="1.0"><!-- <string>planted</string> --><dict><key>Name</key><string>Fixture</string></dict></plist>';
    expect(parsePropertyList(xml)).toEqual({ Name: "Fixture" });
  });

  it("refuses a document whose comment markers overlap, never close, or hold --", () => {
    const overlapping =
      '<?xml version="1.0"?><plist version="1.0"><!-<!-- a -->- <string>planted</string> --><dict><key>Name</key><string>Fixture</string></dict></plist>';
    const unclosed =
      '<plist version="1.0"><dict><key>Name</key><string>Fixture</string></dict><!-- </plist>';
    const htmlStyleEnd =
      '<plist version="1.0"><!-- a --!><dict><key>Name</key><string>Fixture</string></dict><!-- b --></plist>';
    expect(parsePropertyList(overlapping)).toBeUndefined();
    expect(parsePropertyList(unclosed)).toBeUndefined();
    expect(parsePropertyList(htmlStyleEnd)).toBeUndefined();
  });
});
