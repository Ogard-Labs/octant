import { describe, expect, it } from "vitest";
import { sidebarRowPropertiesAll } from "./sidebarRowProperties";

describe("sidebar row property visibility", () => {
  it("hides and shows only the properties the view can put on a row", () => {
    // Projects rows sit under their Project heading already, so Project is not
    // theirs to show and Show all must not claim it is.
    expect(sidebarRowPropertiesAll("projects", true)).toEqual({
      project: false,
      branch: true,
      pullRequest: true,
      lastUpdated: true,
      status: true,
    });
    expect(sidebarRowPropertiesAll("activity", true)).toEqual({
      project: true,
      branch: true,
      pullRequest: true,
      lastUpdated: true,
      status: true,
    });
    expect(sidebarRowPropertiesAll("activity", false)).toEqual({
      project: false,
      branch: false,
      pullRequest: false,
      lastUpdated: false,
      status: false,
    });
  });
});
