import { describe, expect, it } from "vitest";
import { columnsChange, listColumnWidth, openThreadKey, showsColumns } from "./columns";

describe("list and thread columns", () => {
  it("shows columns on an iPad and iPhone Duo's inner screen, and one column on a phone", () => {
    expect(showsColumns(393)).toBe(false);
    // iPhone Duo's cover screen, and its inner screen held either way.
    expect(showsColumns(466)).toBe(false);
    expect(showsColumns(669)).toBe(true);
    expect(showsColumns(951)).toBe(true);
    expect(listColumnWidth(951)).toBe(361);
    expect(listColumnWidth(669)).toBe(300);
  });

  it("puts the open thread on the stack when a foldable is folded", () => {
    expect(columnsChange({ columns: false, openInColumn: "row-1", pushed: [] })).toEqual({
      kind: "push-thread",
      row: "row-1",
    });
    expect(columnsChange({ columns: false, openInColumn: undefined, pushed: [] })).toEqual({
      kind: "none",
    });
  });

  it("takes a thread opened on the phone into the column when it is unfolded", () => {
    expect(
      columnsChange({
        columns: true,
        openInColumn: undefined,
        pushed: [{ name: "thread", row: "row-2" }],
      }),
    ).toEqual({ kind: "take-thread", row: "row-2" });
  });

  it("leaves a deeper path the person took on the stack", () => {
    expect(
      columnsChange({
        columns: true,
        openInColumn: undefined,
        pushed: [{ name: "settings" }, { name: "thread", row: "row-3" }],
      }),
    ).toEqual({ kind: "none" });
  });

  it("opens a thread afresh for each search hit in it, so an older hit loads its page", () => {
    expect(openThreadKey("host:code:t1", "turn-a")).not.toBe(
      openThreadKey("host:code:t1", "turn-b"),
    );
    expect(openThreadKey("host:code:t1", undefined)).toBe("host:code:t1");
  });
});
