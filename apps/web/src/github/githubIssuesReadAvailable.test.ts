import { describe, expect, it, vi } from "vitest";
import type { GithubAuthenticationSnapshot } from "@octant/contracts";
import type { GithubClient } from "@octant/client-runtime/github-client";
import { githubIssuesReadAvailable, withGithubIssuesReadSync } from "./githubIssuesReadAvailable";

const readySnapshot: GithubAuthenticationSnapshot = {
  state: "ready",
  capabilities: [
    { kind: "repository-catalogue", available: true },
    { kind: "issues-read", available: true },
  ],
};

const unauthorizedSnapshot: GithubAuthenticationSnapshot = {
  state: "unauthorized",
  capabilities: [{ kind: "issues-read", available: false }],
};

function makeClient(snapshot: GithubAuthenticationSnapshot): GithubClient {
  return {
    authenticationSnapshot: async () => snapshot,
    executeAuthenticationCommand: async () => snapshot,
    readCatalogue: async () => {
      throw new Error("not used");
    },
    recordRecentRepository: async () => {
      throw new Error("not used");
    },
  };
}

describe("github issues-read capability sync", () => {
  it("treats a snapshot as available only when issues-read is present and true", () => {
    expect(githubIssuesReadAvailable(readySnapshot)).toBe(true);
    expect(githubIssuesReadAvailable(unauthorizedSnapshot)).toBe(false);
    expect(githubIssuesReadAvailable({ state: "ready", capabilities: [] })).toBe(false);
  });

  it("refreshes availability after a successful authentication command", async () => {
    const onAvailable = vi.fn();
    const client = withGithubIssuesReadSync(makeClient(unauthorizedSnapshot), onAvailable);
    await client.executeAuthenticationCommand({
      kind: "logout",
      confirmation: "confirm-github-local-logout",
    });
    expect(onAvailable).toHaveBeenCalledWith(false);
  });

  it("does not refresh availability when the authentication command fails", async () => {
    const onAvailable = vi.fn();
    const client = withGithubIssuesReadSync(
      {
        ...makeClient(readySnapshot),
        executeAuthenticationCommand: async () => {
          throw new Error("GitHub is unavailable.");
        },
      },
      onAvailable,
    );
    await expect(
      client.executeAuthenticationCommand({
        kind: "setup",
        confirmation: "confirm-github-setup",
      }),
    ).rejects.toThrow("GitHub is unavailable.");
    expect(onAvailable).not.toHaveBeenCalled();
  });
});
