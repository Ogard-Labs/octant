import { describe, expect, it } from "vitest";
import { findSentThreadMentions } from "./sentThreadMentions";

describe("findSentThreadMentions", () => {
  const titles = new Map([
    ["a", "Roadmap"],
    ["b", "Renamed since"],
  ]);
  const titleOf = (threadId: string) => titles.get(threadId);

  it("matches each stored id to its thread's title in the text", () => {
    expect(findSentThreadMentions("See #[Roadmap] and #[typed by hand]", ["a"], titleOf)).toEqual([
      { start: 4, end: 14, text: "#[Roadmap]", threadId: "a" },
    ]);
  });

  it("still finds a thread renamed since when only one place is left for it", () => {
    expect(
      findSentThreadMentions("#[Old name] #[Roadmap]", ["b", "a"], titleOf).map(
        (mention) => mention.threadId,
      ),
    ).toEqual(["b", "a"]);
    expect(findSentThreadMentions("#[Old name] #[another]", ["b"], titleOf)).toEqual([]);
  });

  it("never gives an unlisted or renamed thread's place to another of the same title", () => {
    const text = "#[Roadmap] and #[Roadmap]";
    const start = text.lastIndexOf("#");
    expect(findSentThreadMentions(text, ["gone", "a"], titleOf)).toEqual([
      { start, end: text.length, text: "#[Roadmap]", threadId: "a" },
    ]);
    expect(
      findSentThreadMentions(text, ["b", "a"], titleOf).map((mention) => mention.threadId),
    ).toEqual(["b", "a"]);
    // With text typed by hand beside them, whose place is whose cannot be told.
    expect(findSentThreadMentions(`${text} #[typed]`, ["gone", "a"], titleOf)).toEqual([]);
  });

  it("keeps the place of a thread renamed to a title the message already holds", () => {
    const renamed = (threadId: string) => ({ a: "Roadmap", b: "Roadmap" })[threadId];
    expect(
      findSentThreadMentions("#[Roadmap] #[Launch]", ["a", "b"], renamed).map((mention) => [
        mention.text,
        mention.threadId,
      ]),
    ).toEqual([
      ["#[Roadmap]", "a"],
      ["#[Launch]", "b"],
    ]);
  });

  it("does not trust an order its titles contradict", () => {
    const listed = (threadId: string) => ({ a: "Roadmap", b: "Launch" })[threadId];
    expect(
      findSentThreadMentions("#[Roadmap] #[Launch]", ["b", "a"], listed).map((mention) => [
        mention.text,
        mention.threadId,
      ]),
    ).toEqual([
      ["#[Roadmap]", "a"],
      ["#[Launch]", "b"],
    ]);
  });

  it("leaves a message with no stored ids, and an unlisted thread, as text", () => {
    expect(findSentThreadMentions("#[Roadmap]", [], titleOf)).toEqual([]);
    expect(findSentThreadMentions("#[Gone]", ["missing"], titleOf)).toEqual([]);
  });
});
