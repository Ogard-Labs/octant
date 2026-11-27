import { describe, expect, it } from "vitest";
import {
  findTrackerMentionSpans,
  findTrackerMentions,
  formatTrackerMentionReference,
  parseTrackerMentionQuery,
} from "./trackerMentionPolicy";

const pull = "https://github.com/acme/app/pull/2901";
const issue = "https://github.com/acme/app/issues/12";
const linear = "https://linear.app/acme/issue/OCT-1042/mention-things";

describe("tracker mention references", () => {
  it("writes a pull request or issue as a plain reference the provider can follow", () => {
    expect(
      formatTrackerMentionReference({ label: "#2901", title: "Fix [the]\nlogin", url: pull }),
    ).toBe(`[#2901 Fix the login](${pull})`);
  });

  it("records each referenced item once, in the order the text shows them", () => {
    const text = `see [OCT-1042 Mention things](${linear}) then [#12 Bug](${issue}) and [#2901 Fix](${pull}) and [#12 Bug](${issue})`;
    expect(findTrackerMentions(text)).toEqual([
      { kind: "linear-issue", source: "linear", id: "OCT-1042", url: linear },
      { kind: "github-issue", source: "github", id: "12", url: issue },
      { kind: "pull-request", source: "github", id: "2901", url: pull },
    ]);
    expect(findTrackerMentionSpans(text)).toHaveLength(4);
  });

  it("leaves a link whose label names a different item or another site as text", () => {
    expect(findTrackerMentions(`[#1 Fix](${pull})`)).toEqual([]);
    expect(findTrackerMentions(`[OCT-1 x](${linear})`)).toEqual([]);
    expect(findTrackerMentions("[#12 x](https://example.com/acme/app/issues/12)")).toEqual([]);
    expect(findTrackerMentions("[#12 x](http://github.com/acme/app/issues/12)")).toEqual([]);
    expect(findTrackerMentions("#2901 on its own")).toEqual([]);
    expect(findTrackerMentions("#[A thread title]")).toEqual([]);
  });

  it("reads a typed query as a number, a Linear key, or title words", () => {
    expect(parseTrackerMentionQuery("2901")).toEqual({ kind: "number", number: 2901 });
    expect(parseTrackerMentionQuery("#2901")).toEqual({ kind: "number", number: 2901 });
    expect(parseTrackerMentionQuery("oct-1042")).toEqual({ kind: "key", key: "OCT-1042" });
    expect(parseTrackerMentionQuery("login")).toEqual({ kind: "title", text: "login" });
    expect(parseTrackerMentionQuery("")).toBeUndefined();
    expect(parseTrackerMentionQuery("a")).toBeUndefined();
  });
});
