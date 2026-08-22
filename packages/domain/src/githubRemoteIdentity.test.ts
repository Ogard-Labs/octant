import { describe, expect, it } from "vitest";
import { parseGithubRemote } from "./githubRemoteIdentity";

describe("GitHub remote identity", () => {
  it("resolves HTTPS, SCP-style, and ssh:// github.com remotes to owner and repository", () => {
    expect(parseGithubRemote("https://github.com/octant/octant.git")).toEqual({
      status: "resolved",
      identity: { owner: "octant", name: "octant" },
    });
    expect(parseGithubRemote("https://github.com/octant/octant")).toEqual({
      status: "resolved",
      identity: { owner: "octant", name: "octant" },
    });
    expect(parseGithubRemote("git@github.com:octant/octant.git")).toEqual({
      status: "resolved",
      identity: { owner: "octant", name: "octant" },
    });
    expect(parseGithubRemote("ssh://git@github.com/octant/octant.git")).toEqual({
      status: "resolved",
      identity: { owner: "octant", name: "octant" },
    });
    expect(parseGithubRemote("ssh://github.com/octant/octant.git")).toEqual({
      status: "resolved",
      identity: { owner: "octant", name: "octant" },
    });
  });

  it("fails closed on userinfo, credentials, non-github hosts, and enterprise-looking hosts", () => {
    expect(parseGithubRemote("https://user:secret@github.com/octant/octant.git")).toEqual({
      status: "unconnected",
    });
    expect(parseGithubRemote("https://token@github.com/octant/octant.git")).toEqual({
      status: "unconnected",
    });
    expect(parseGithubRemote("ssh://attacker:secret@github.com/octant/octant.git")).toEqual({
      status: "unconnected",
    });
    expect(parseGithubRemote("https://gitlab.com/octant/octant.git")).toEqual({
      status: "unconnected",
    });
    expect(parseGithubRemote("git@gitlab.com:octant/octant.git")).toEqual({
      status: "unconnected",
    });
    expect(parseGithubRemote("https://github.example.com/octant/octant.git")).toEqual({
      status: "unconnected",
    });
    expect(parseGithubRemote("git@github.enterprise.local:octant/octant.git")).toEqual({
      status: "unconnected",
    });
    expect(parseGithubRemote("https://gist.github.com/octant/octant.git")).toEqual({
      status: "unconnected",
    });
    expect(parseGithubRemote("https://github.com.evil.test/octant/octant.git")).toEqual({
      status: "unconnected",
    });
    expect(parseGithubRemote("https://github.com/octant/octant/extra")).toEqual({
      status: "unconnected",
    });
    expect(parseGithubRemote("not-a-remote")).toEqual({ status: "unconnected" });
  });
});
