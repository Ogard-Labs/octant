import { describe, expect, it } from "vitest";
import {
  decodeGithubActionsSourceRead,
  decodeGithubActionsSourceResult,
} from "./githubActionsSource";

const repository = { id: 777, nodeId: "R_fixture777", owner: "fixture-owner", name: "repo" };
const request = {
  credentialRef: "55000000-0000-4000-8000-000000000001",
  clientId: "owned-app",
  secretRef: "55000000-0000-4000-8000-000000000002",
  accountId: "12345",
  kind: "runs",
  repository,
  page: 1,
};
const result = {
  kind: "page",
  accountId: "12345",
  repository,
  totalCount: 1,
  runs: [
    {
      id: 456,
      attempt: 2,
      workflowId: 89,
      headSha: "a".repeat(40),
      branch: "development",
      conclusion: "failure",
      createdAt: "2026-11-03T10:00:00Z",
      updatedAt: "2026-11-03T10:01:00Z",
      url: "https://github.com/fixture-owner/repo/actions/runs/456",
    },
  ],
};

describe("closed GitHub Actions broker metadata", () => {
  it("decodes only a selected source read and completed-attempt metadata, not arbitrary HTTP", () => {
    expect(decodeGithubActionsSourceRead(request)).toEqual(request);
    expect(decodeGithubActionsSourceResult(result)).toEqual(result);
  });
  it.each([
    { ...request, url: "https://other.invalid" },
    { ...request, method: "POST" },
    { ...request, headers: { authorization: "synthetic" } },
    { ...request, accountId: "9007199254740992" },
    { ...request, secretRef: "guessed" },
    { ...request, page: 6 },
    { ...request, repository: { ...repository, owner: "user@host" } },
    { ...request, repository: { ...repository, name: "../another" } },
    { ...request, repository: { ...repository, id: Number.MAX_SAFE_INTEGER + 1 } },
    { ...request, branch: "bad\nbranch" },
    { ...request, workflowId: 0 },
  ])("refuses an invalid or broadened private request %#", (value) => {
    expect(decodeGithubActionsSourceRead(value)).toBeUndefined();
  });
  it.each([
    { ...result, accessToken: "must-never-escape" },
    { ...result, credentialRef: request.credentialRef },
    { ...result, nextPage: 7 },
    { ...result, totalCount: -1 },
    { ...result, runs: [{ ...result.runs[0], attempt: 0 }] },
    { ...result, runs: [{ ...result.runs[0], id: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...result, runs: [{ ...result.runs[0], logs_url: "https://other.invalid" }] },
    {
      ...result,
      runs: [{ ...result.runs[0], url: "https://github.com/other/repo/actions/runs/456" }],
    },
    { ...result, runs: [{ ...result.runs[0], branch: "bad\0branch" }] },
    { ...result, runs: [{ ...result.runs[0], createdAt: "not-a-date" }] },
  ])("refuses excess, mismatched or malformed metadata %#", (value) => {
    expect(decodeGithubActionsSourceResult(value)).toBeUndefined();
  });
});
