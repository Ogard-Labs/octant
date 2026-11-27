import { expect, it } from "vitest";
import { appendComposerQuote } from "./composerQuote";
import {
  appendToResultQuoteDraft,
  rememberResultQuotePlaces,
  resultQuotePlaces,
} from "./resultQuoteDraft";

it("keeps append-preserved references in another thread after repeated edits", () => {
  const quote = { source: "a subagent result", text: "Identical excerpt", comment: "" };
  const a = "chat:live-a";
  const b = "chat:live-b";
  const beforeA = appendComposerQuote("", quote, {
    threadId: a,
    result: { label: quote.source, threadId: a, row: "a", block: "0" },
  });
  const beforeB = appendComposerQuote("", quote, {
    threadId: b,
    result: { label: quote.source, threadId: b, row: "b", block: "0" },
  });
  const afterA = appendToResultQuoteDraft(a, beforeA, `${beforeA.trimEnd()}\n\nInserted note`);
  const positions = resultQuotePlaces(b, beforeB);
  for (let index = 0; index < 150; index += 1) {
    rememberResultQuotePlaces(b, `${beforeB}${index}`, positions);
  }
  expect(resultQuotePlaces(a, beforeA)).toEqual([]);
  expect(resultQuotePlaces(a, afterA).map((place) => place.source.row)).toEqual(["a"]);
  expect(resultQuotePlaces(b, `${beforeB}149`).map((place) => place.source.row)).toEqual(["b"]);
});
