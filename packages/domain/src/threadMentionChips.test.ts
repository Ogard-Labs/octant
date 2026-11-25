import { describe, expect, it } from "vitest";
import { findThreadMentionTags, reconcileThreadMentionChips } from "./threadMentionChips";
import { formatThreadMentionChip } from "./threadMentionChipText";

describe("reconcileThreadMentionChips", () => {
  it("drops a chip the user edited out of the draft", () => {
    const chips = [{ title: "Release notes" }, { title: "Roadmap" }];
    const draft = `${formatThreadMentionChip("Roadmap")} only`;
    expect(reconcileThreadMentionChips(draft, chips)).toEqual([{ title: "Roadmap" }]);
  });

  it("keeps one same-title chip per surviving token", () => {
    const chips = [{ title: "Roadmap" }, { title: "Roadmap" }];
    const draft = `${formatThreadMentionChip("Roadmap")} only`;
    expect(reconcileThreadMentionChips(draft, chips)).toEqual([{ title: "Roadmap" }]);
    expect(
      reconcileThreadMentionChips(
        `${formatThreadMentionChip("Roadmap")} and ${formatThreadMentionChip("Roadmap")}`,
        chips,
      ),
    ).toEqual(chips);
  });

  it("caps surviving chips at the per-turn bound", () => {
    const titles = ["One", "Two", "Three", "Four", "Five"];
    const draft = titles.map((title) => formatThreadMentionChip(title)).join(" ");
    expect(
      reconcileThreadMentionChips(
        draft,
        titles.map((title) => ({ title })),
      ),
    ).toHaveLength(4);
  });
});

describe("following chips through an edit", () => {
  const first = { id: "a", title: "Roadmap" };
  const second = { id: "b", title: "Roadmap" };
  const before = "Use #[Roadmap] and #[Roadmap] today";

  it("removes the deleted thread of two that share a title and keeps the other", () => {
    const after = "Use  and #[Roadmap] today";
    expect(reconcileThreadMentionChips(after, [first, second], { draft: before })).toEqual([
      second,
    ]);
    expect(
      reconcileThreadMentionChips("Use #[Roadmap] and  today", [first, second], { draft: before }),
    ).toEqual([first]);
  });

  it("keeps the thread that was not cut when the two stand side by side", () => {
    const beside = "#[Roadmap] #[Roadmap]";
    // Both cuts leave the same text; only where the caret ended tells them apart.
    expect(
      reconcileThreadMentionChips("#[Roadmap]", [first, second], { draft: beside, caret: 0 }),
    ).toEqual([second]);
    expect(
      reconcileThreadMentionChips("#[Roadmap]", [first, second], { draft: beside, caret: 10 }),
    ).toEqual([first]);
  });

  it("reports the chips in the order the draft shows them", () => {
    const launch = { id: "c", title: "Launch" };
    expect(
      reconcileThreadMentionChips("#[Launch] then #[Roadmap]", [first, launch], {
        draft: "then #[Roadmap]",
      }),
    ).toEqual([launch, first]);
  });

  it("places a same-title thread chosen before another one first", () => {
    const after = "#[Roadmap] #[Roadmap]";
    expect(reconcileThreadMentionChips(after, [first, second], { draft: " #[Roadmap]" })).toEqual([
      second,
      first,
    ]);
  });

  it("brings a dropped thread back when an undo or a paste brings its text back", () => {
    const dropped = [first];
    expect(reconcileThreadMentionChips("Use #[Roadmap]", [], { dropped })).toEqual([first]);
    expect(reconcileThreadMentionChips("Use Roadmap", [], { dropped })).toEqual([]);
  });
});

describe("findThreadMentionTags", () => {
  it("finds each chip's place and leaves unclaimed bracket text alone", () => {
    const chip = { title: "Plan [v2]" };
    const text = "#[Other] #[Plan v2] #[";
    expect(findThreadMentionTags(text, [chip])).toEqual([
      { start: 9, end: 19, text: "#[Plan v2]", chip },
    ]);
  });

  it("finds a chip behind brackets left open before it", () => {
    const chip = { title: "Plan" };
    expect(findThreadMentionTags("#[#[ [#[Plan]", [chip]).map((tag) => tag.start)).toEqual([6]);
  });

  it("lets repeated text stand for the same thread", () => {
    const chip = { title: "Plan" };
    expect(findThreadMentionTags("#[Plan] #[Plan]", [chip]).map((tag) => tag.chip)).toEqual([
      chip,
      chip,
    ]);
  });
});
