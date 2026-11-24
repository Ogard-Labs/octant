import { describe, expect, it, vi } from "vitest";
import { prepareComposerStashFiles } from "./prepareComposerStashFiles";

describe("restoring saved attachments", () => {
  it("releases tentative uploads and keeps the current draft if a later upload fails", async () => {
    const original = { id: "original", file: new File(["original"], "original.txt") };
    const added = { id: "new", file: new File(["saved"], "saved.txt") };
    const refused = new File(["problem"], "problem.txt");
    const apply = vi.fn();
    const discard = vi.fn();

    const result = await prepareComposerStashFiles({
      current: [original],
      files: [original.file, added.file, refused],
      stage: async (file) => {
        if (file === refused) throw new Error("The destination cannot accept the file");
        return { kind: "staged", entry: added };
      },
      discard,
      apply,
    });

    expect(result).toEqual({ kind: "refused", reason: "problem.txt could not be restored." });
    expect(discard).toHaveBeenCalledExactlyOnceWith(added);
    expect(apply).not.toHaveBeenCalled();
  });

  it("discards the previous host reference after the composer accepts the replacement", async () => {
    const original = { id: "original", file: new File(["original"], "original.txt") };
    const replacement = { id: "new", file: new File(["saved"], "saved.txt") };
    const apply = vi.fn();
    const discard = vi.fn();
    const result = await prepareComposerStashFiles({
      current: [original],
      files: [replacement.file],
      stage: async () => ({ kind: "staged", entry: replacement }),
      discard,
      apply,
    });

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(discard).not.toHaveBeenCalled();
    result.apply();
    expect(apply).toHaveBeenCalledExactlyOnceWith([replacement]);
    expect(discard).toHaveBeenCalledExactlyOnceWith(original);
  });

  it("explains a known attachment incompatibility in the destination", async () => {
    const original = { file: new File(["existing"], "existing.txt") };
    const reason = "This model cannot read this file. Choose a compatible model.";
    const apply = vi.fn();
    const discard = vi.fn();
    const result = await prepareComposerStashFiles({
      current: [original],
      files: [original.file, new File(["data"], "archive.zip")],
      stage: async () => ({ kind: "refused", reason }),
      discard,
      apply,
    });

    expect(result).toEqual({ kind: "refused", reason });
    expect(apply).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });
});
