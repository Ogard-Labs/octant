import { describe, expect, it } from "vitest";
import { decodeThreadWorkingDirectory } from "@octant/contracts";
import { workThreadOwnFolder } from "./workThreadMoveFolder";

const main = { kind: "main", root: "/Users/person/Offsite" } as const;
const report = decodeThreadWorkingDirectory("report");

describe("which Work folder a move carries", () => {
  it("carries the subfolder a thread was started in when no other thread or Project uses it", () => {
    expect(
      workThreadOwnFolder({
        workingFolder: main,
        workingDirectory: report,
        // A thread working in the Project folder above does not share it.
        otherThreadFolders: ["/Users/person/Offsite", "/Users/person/Offsite/reports"],
        projectFolders: ["/Users/person/Offsite"],
      }),
    ).toEqual({ status: "own", folder: "/Users/person/Offsite/report", workingDirectory: report });
  });

  it("leaves the Project folder, an extra folder, and a shared subfolder where they are", () => {
    const shared = { otherThreadFolders: [], projectFolders: [] };
    expect(
      workThreadOwnFolder({ ...shared, workingFolder: main, workingDirectory: undefined }),
    ).toEqual({ status: "stays", reason: "project-folder" });
    expect(
      workThreadOwnFolder({
        ...shared,
        workingFolder: { kind: "extra" },
        workingDirectory: report,
      }),
    ).toEqual({ status: "stays", reason: "extra-folder" });
    expect(
      workThreadOwnFolder({
        ...shared,
        workingFolder: main,
        workingDirectory: report,
        otherThreadFolders: ["/Users/person/Offsite/report/drafts"],
      }),
    ).toEqual({ status: "stays", reason: "shared" });
    expect(
      workThreadOwnFolder({
        ...shared,
        workingFolder: main,
        workingDirectory: report,
        projectFolders: ["/Users/person/Offsite/report"],
      }),
    ).toEqual({ status: "stays", reason: "shared" });
  });
});
