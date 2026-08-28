import { describe, expect, it } from "vitest";
import { decodeGithubIssueContextRequest } from "./githubIssueContext";

describe("GitHub issue context request", () => {
  it("accepts only owner, name, and number", () => {
    expect(decodeGithubIssueContextRequest({ owner: "octant", name: "octant", number: 7 })).toEqual(
      { owner: "octant", name: "octant", number: 7 },
    );
  });

  it("rejects mutation fields and assembled issue text", () => {
    expect(() =>
      decodeGithubIssueContextRequest({
        owner: "octant",
        name: "octant",
        number: 7,
        body: "assembled text",
      }),
    ).toThrow();
    expect(() =>
      decodeGithubIssueContextRequest({
        owner: "octant",
        name: "octant",
        number: 7,
        comment: "please close this",
      }),
    ).toThrow();
    expect(() =>
      decodeGithubIssueContextRequest({
        owner: "octant",
        name: "octant",
        number: 7,
        write: true,
      }),
    ).toThrow();
  });

  it("rejects invalid repository identity", () => {
    expect(() =>
      decodeGithubIssueContextRequest({ owner: "own/er", name: "octant", number: 7 }),
    ).toThrow();
    expect(() =>
      decodeGithubIssueContextRequest({ owner: "octant", name: "..", number: 7 }),
    ).toThrow();
    expect(() =>
      decodeGithubIssueContextRequest({ owner: "octant", name: "octant", number: 0 }),
    ).toThrow();
  });
});
