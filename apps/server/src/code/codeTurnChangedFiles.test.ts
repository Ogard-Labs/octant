import { MAX_CODE_TURN_CHANGED_PATHS } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { turnChangedFiles } from "./codeTurnChangedFiles";

const change = (path: string, insertions = 1, deletions = 0, binary = false) => ({
  path,
  insertions,
  deletions,
  binary,
});

describe("what a Code turn records as changed", () => {
  it("keeps no record for a turn that changed nothing", () => {
    expect(turnChangedFiles([])).toBeUndefined();
  });

  it("keeps each path with its line counts and says when a file is binary", () => {
    expect(turnChangedFiles([change("src/app.ts", 12, 3), change("logo.png", 0, 0, true)])).toEqual(
      {
        files: [
          { path: "src/app.ts", insertions: 12, deletions: 3 },
          { path: "logo.png", insertions: 0, deletions: 0, binary: true },
        ],
        total: 2,
        truncated: false,
      },
    );
  });

  it("drops a path that leaves the checkout and says the record is incomplete", () => {
    const record = turnChangedFiles([change("../outside.ts"), change("src/app.ts")]);
    expect(record?.files.map((file) => file.path)).toEqual(["src/app.ts"]);
    // The count is what Git reported, so the surface can say something is missing.
    expect(record).toMatchObject({ total: 2, truncated: true });
  });

  it("bounds a turn that rewrote a large tree and says so", () => {
    const record = turnChangedFiles(
      Array.from({ length: MAX_CODE_TURN_CHANGED_PATHS + 5 }, (_, index) =>
        change(`src/file-${String(index).padStart(3, "0")}.ts`),
      ),
    );
    expect(record?.files).toHaveLength(MAX_CODE_TURN_CHANGED_PATHS);
    expect(record).toMatchObject({ total: MAX_CODE_TURN_CHANGED_PATHS + 5, truncated: true });
  });
});
