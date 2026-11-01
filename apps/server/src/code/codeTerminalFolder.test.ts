import { describe, expect, it } from "vitest";
import { chooseThreadTerminalFolder } from "./codeTerminalFolder";

const present = () => true;

describe("chooseThreadTerminalFolder", () => {
  it("starts in the working directory and binds the extra folders when none is picked", () => {
    expect(
      chooseThreadTerminalFolder({
        workingDirectory: "/work/main",
        extraFolders: ["/work/notes"],
        picked: undefined,
        isDirectory: present,
      }),
    ).toEqual({ kind: "chosen", cwd: "/work/main", extraFolders: ["/work/notes"] });
  });

  it("starts in a picked extra folder and binds the working directory beside it", () => {
    expect(
      chooseThreadTerminalFolder({
        workingDirectory: "/work/main",
        extraFolders: ["/work/notes", "/work/data"],
        picked: "/work/notes",
        isDirectory: present,
      }),
    ).toEqual({ kind: "chosen", cwd: "/work/notes", extraFolders: ["/work/main", "/work/data"] });
  });

  it("refuses a folder the Project does not list, a lookalike, and a listed folder gone from disk", () => {
    const base = { workingDirectory: "/work/main", extraFolders: ["/work/notes"] };
    expect(
      chooseThreadTerminalFolder({ ...base, picked: "/work/other", isDirectory: present }),
    ).toEqual({ kind: "refused" });
    expect(
      chooseThreadTerminalFolder({ ...base, picked: "/work/notes/", isDirectory: present }),
    ).toEqual({ kind: "refused" });
    expect(
      chooseThreadTerminalFolder({ ...base, picked: "/work/notes", isDirectory: () => false }),
    ).toEqual({ kind: "refused" });
  });

  it("leaves an extra folder that is missing on disk out of the bound folders", () => {
    expect(
      chooseThreadTerminalFolder({
        workingDirectory: "/work/main",
        extraFolders: ["/work/gone"],
        picked: undefined,
        isDirectory: (path) => path !== "/work/gone",
      }),
    ).toEqual({ kind: "chosen", cwd: "/work/main", extraFolders: [] });
  });
});
