import { describe, expect, it } from "vitest";
import { createThreadDrafts } from "./threadDrafts";

describe("what is being written in a thread", () => {
  it("is cleared by the send that took it, and not what was written since", () => {
    const drafts = createThreadDrafts();
    const cleared: string[] = [];
    drafts.onSent((thread, text) => cleared.push(`${thread} ${text}`));
    drafts.keep("a", "one");
    drafts.sent("a", "one");
    expect(drafts.read("a")).toBe("");
    drafts.keep("a", "two");
    drafts.sent("a", "one");
    expect(drafts.read("a")).toBe("two");
    expect(cleared).toEqual(["a one", "a one"]);
  });

  it("leaves with the computer it was written to", () => {
    const drafts = createThreadDrafts();
    drafts.keep("a:1", "one");
    drafts.keep("b:1", "two");
    drafts.keepOnly((thread) => thread.startsWith("b:"));
    expect(drafts.read("a:1")).toBe("");
    expect(drafts.read("b:1")).toBe("two");
  });

  it("remembers words whose send had no clear answer until they are sent", () => {
    const drafts = createThreadDrafts();
    drafts.noteMayBeSent("a", " one ");
    expect(drafts.mayBeSent("a")).toBe("one");
    expect(drafts.mayBeSent("b")).toBeUndefined();
    drafts.sent("a", "one");
    expect(drafts.mayBeSent("a")).toBeUndefined();
  });
});
