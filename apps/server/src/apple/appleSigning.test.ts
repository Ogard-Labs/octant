import { describe, expect, it } from "vitest";
import { parsePropertyList } from "./appleSigning";

describe("provisioning property lists", () => {
  it("removes a comment that overlapping markers leave behind and never reads its contents", () => {
    const xml =
      '<?xml version="1.0"?><plist version="1.0"><!-<!-- a -->- <string>planted</string> --><dict><key>Name</key><string>Fixture</string></dict></plist>';
    expect(parsePropertyList(xml)).toEqual({ Name: "Fixture" });
  });
});
