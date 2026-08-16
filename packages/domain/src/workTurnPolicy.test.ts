import { describe, expect, it } from "vitest";
import { decodeWorkTurnAuthority } from "@octant/contracts/work-turns";
import { decideWorkTurnAuthority } from "./workTurnPolicy";

const ids = {
  project: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  binding: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  otherBinding: "99999999-9999-4999-8999-999999999999",
  provider: "ffffffff-ffff-4fff-8fff-ffffffffffff",
} as const;

const authority = decodeWorkTurnAuthority({
  hostId: "local",
  projectId: ids.project,
  bindingRevisionId: ids.binding,
  workingDirectory: ".",
  confinementPosture: "project-root-confined",
  providerInstanceId: ids.provider,
  modelId: "gpt-5",
});

const project = {
  type: "work",
  lifecycle: "active",
  bindingHistory: [{ revisionId: ids.binding }],
  binding: { canonicalRoot: "/tmp/work-project" },
};

const thread = {
  projectId: ids.project,
  lifecycle: "active",
  providerInstanceId: ids.provider,
  modelId: "gpt-5",
  bindingRevisionId: ids.binding,
  workingDirectory: ".",
};

describe("decideWorkTurnAuthority", () => {
  it("allows an exact host, Project, binding, working directory, and confined posture", () => {
    expect(
      decideWorkTurnAuthority({
        authority,
        expectedHostId: "local",
        project,
        thread,
      }),
    ).toEqual({ kind: "allow" });
  });

  it("denies a mismatched host", () => {
    expect(
      decideWorkTurnAuthority({
        authority,
        expectedHostId: "other-host",
        project,
        thread,
      }),
    ).toMatchObject({ kind: "deny", category: "unauthorized" });
  });

  it("denies a stale binding revision", () => {
    expect(
      decideWorkTurnAuthority({
        authority,
        expectedHostId: "local",
        project: {
          ...project,
          bindingHistory: [{ revisionId: ids.otherBinding }],
        },
        thread,
      }),
    ).toMatchObject({ kind: "deny", category: "stale" });
  });

  it("denies a Code Project or inactive thread without granting Code authority", () => {
    expect(
      decideWorkTurnAuthority({
        authority,
        expectedHostId: "local",
        project: { ...project, type: "code" },
        thread,
      }),
    ).toMatchObject({ kind: "deny", category: "unauthorized" });

    expect(
      decideWorkTurnAuthority({
        authority,
        expectedHostId: "local",
        project,
        thread: { ...thread, lifecycle: "archived" },
      }),
    ).toMatchObject({ kind: "deny", category: "invalid" });
  });

  it("denies a provider or working-directory drift on the thread", () => {
    expect(
      decideWorkTurnAuthority({
        authority,
        expectedHostId: "local",
        project,
        thread: { ...thread, modelId: "other-model" },
      }),
    ).toMatchObject({ kind: "deny", category: "stale" });

    expect(
      decideWorkTurnAuthority({
        authority,
        expectedHostId: "local",
        project,
        thread: { ...thread, workingDirectory: "docs" },
      }),
    ).toMatchObject({ kind: "deny", category: "stale" });
  });
});
