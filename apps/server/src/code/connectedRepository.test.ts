import { describe, expect, it } from "vitest";
import { resolveConnectedGitHubRepository } from "./connectedRepository";

describe("connected GitHub repository observation", () => {
  it("returns only the owner and repository from a matching HTTPS remote pair", () => {
    expect(
      resolveConnectedGitHubRepository([
        {
          name: "origin",
          fetchUrl: "https://github.com/Acme/example.git",
          pushUrl: "https://github.com/Acme/example.git",
        },
      ]),
    ).toEqual({ host: "github.com", owner: "Acme", repository: "example" });
  });

  it.each([
    ["credential-bearing HTTPS", "https://token:secret@github.com/acme/example.git"],
    ["non-GitHub host", "https://gitlab.com/acme/example.git"],
    ["malformed path", "https://github.com/acme/example/extra.git"],
  ])("refuses %s remotes", (_label, url) => {
    expect(
      resolveConnectedGitHubRepository([{ name: "origin", fetchUrl: url, pushUrl: url }]),
    ).toBeUndefined();
  });

  it("accepts the standard non-secret GitHub SSH form", () => {
    expect(
      resolveConnectedGitHubRepository([
        {
          name: "origin",
          fetchUrl: "git@github.com:acme/example.git",
          pushUrl: "git@github.com:acme/example.git",
        },
      ]),
    ).toEqual({ host: "github.com", owner: "acme", repository: "example" });
  });

  it("refuses conflicting GitHub remotes instead of guessing", () => {
    expect(
      resolveConnectedGitHubRepository([
        {
          name: "origin",
          fetchUrl: "https://github.com/acme/one.git",
          pushUrl: "https://github.com/acme/one.git",
        },
        {
          name: "upstream",
          fetchUrl: "https://github.com/acme/two.git",
          pushUrl: "https://github.com/acme/two.git",
        },
      ]),
    ).toBeUndefined();
  });

  it("refuses a fetch/push identity mismatch", () => {
    expect(
      resolveConnectedGitHubRepository([
        {
          name: "origin",
          fetchUrl: "https://github.com/acme/one.git",
          pushUrl: "https://github.com/acme/two.git",
        },
      ]),
    ).toBeUndefined();
  });

  it("refuses URLs whose credentials were redacted before observation", () => {
    expect(
      resolveConnectedGitHubRepository([
        {
          name: "origin",
          fetchUrl: "https://github.com/acme/example.git",
          pushUrl: "https://github.com/acme/example.git",
          credentialed: true,
        },
      ]),
    ).toBeUndefined();
  });

  it("refuses a valid GitHub remote beside an invalid remote", () => {
    expect(
      resolveConnectedGitHubRepository([
        {
          name: "origin",
          fetchUrl: "https://github.com/acme/example.git",
          pushUrl: "https://github.com/acme/example.git",
        },
        {
          name: "upstream",
          fetchUrl: "https://gitlab.com/acme/example.git",
          pushUrl: "https://gitlab.com/acme/example.git",
        },
      ]),
    ).toBeUndefined();
  });
});
