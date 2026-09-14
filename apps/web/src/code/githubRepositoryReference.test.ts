import { describe, expect, it } from "vitest";
import { parseGithubRepositoryReference } from "./githubRepositoryReference";

describe("parseGithubRepositoryReference", () => {
  it("accepts owner/repository and github.com repository URLs", () => {
    for (const input of [
      "octant/octant",
      " octant/octant ",
      "octant/octant.git",
      "https://github.com/octant/octant",
      "https://github.com/octant/octant.git",
      "https://github.com/octant/octant/",
      "https://www.github.com/octant/octant",
      "github.com/octant/octant",
    ]) {
      expect(parseGithubRepositoryReference(input)).toEqual({ owner: "octant", name: "octant" });
    }
  });

  it("keeps repositories whose names contain dots, dashes, and underscores", () => {
    expect(parseGithubRepositoryReference("octant-labs/repo.name_1")).toEqual({
      owner: "octant-labs",
      name: "repo.name_1",
    });
  });

  it("refuses other hosts, credentials, ports, paths, queries, and fragments", () => {
    for (const input of [
      "https://gitlab.com/octant/octant",
      "https://evil.example.com/octant/octant",
      "https://github.com.evil.example/octant/octant",
      "https://user:token@github.com/octant/octant",
      "https://github.com:8443/octant/octant",
      "https://github.com/octant/octant/tree/main",
      "https://github.com/octant/octant?tab=readme",
      "https://github.com/octant/octant#readme",
      "git@github.com:octant/octant.git",
      "ssh://github.com/octant/octant",
      "http://github.com/octant/octant",
      "octant/octant/extra",
      "octant",
      "",
      " ",
    ]) {
      expect(parseGithubRepositoryReference(input)).toBeUndefined();
    }
  });

  it("refuses owner and name shapes the server contract would reject", () => {
    for (const input of [
      "-octant/octant",
      "octant-/octant",
      `${"a".repeat(40)}/octant`,
      "octant/..",
      "octant/.",
      `octant/${"a".repeat(101)}`,
      "own er/repo",
      "octant/re po",
    ]) {
      expect(parseGithubRepositoryReference(input)).toBeUndefined();
    }
  });
});
