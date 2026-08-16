import { describe, expect, it } from "vitest";
import { decodeCodeEnvironmentObservation, decodeThreadWorkingDirectory } from "./environment";

const ids = {
  project: "11111111-1111-4111-8111-111111111111",
} as const;

const ready = {
  status: "ready",
  projectId: ids.project,
  projectName: "Octant",
  repositoryRoot: "/Users/example/Dev/Repos/octant",
  worktreeRoot: "/Users/example/Dev/Repos/octant/.agent-worktrees/issue-52-distilled-shell",
  branch: { kind: "named", name: "feature/issue-52-distilled-shell" },
  changes: "dirty",
  observedAt: "2026-07-16T20:00:00.000Z",
} as const;

describe("Code environment observation", () => {
  it("accepts the Project root and bounded canonical relative working directories", () => {
    expect(decodeThreadWorkingDirectory(".")).toBe(".");
    expect(decodeThreadWorkingDirectory("packages/app")).toBe("packages/app");
  });

  it.each([
    "",
    "/private/project",
    "../sibling",
    "packages/../sibling",
    "packages//app",
    "packages\\app",
    "packages/./app",
    "packages/app/",
    "packages/\0app",
    "e\u0301",
    "a".repeat(4_097),
  ])("rejects unsafe working-directory identity %s", (value) => {
    expect(() => decodeThreadWorkingDirectory(value)).toThrow();
  });

  it("decodes named and detached ready observations", () => {
    expect(decodeCodeEnvironmentObservation(ready)).toEqual(ready);
    expect(
      decodeCodeEnvironmentObservation({
        ...ready,
        branch: { kind: "detached", oid: "a".repeat(40) },
        changes: "clean",
      }),
    ).toMatchObject({ branch: { kind: "detached" }, changes: "clean" });
  });

  it.each(["unavailable", "failed"] as const)("decodes a strict %s observation", (status) => {
    expect(
      decodeCodeEnvironmentObservation({
        status,
        projectId: ids.project,
        projectName: "Octant",
        reason:
          status === "unavailable"
            ? "Git is not initialized for this Code Project."
            : "Octant could not inspect Git state.",
        observedAt: "2026-07-16T20:00:00.000Z",
      }),
    ).toMatchObject({ status });
  });

  it("rejects extra properties", () => {
    expect(() => decodeCodeEnvironmentObservation({ ...ready, extra: true })).toThrow();
  });

  it.each([
    { field: "repositoryRoot", value: "" },
    { field: "worktreeRoot", value: "" },
  ] as const)("rejects an empty $field", ({ field, value }) => {
    expect(() => decodeCodeEnvironmentObservation({ ...ready, [field]: value })).toThrow();
  });

  it("rejects an empty named branch", () => {
    expect(() =>
      decodeCodeEnvironmentObservation({
        ...ready,
        branch: { kind: "named", name: "" },
      }),
    ).toThrow();
  });

  it.each(["short", "A".repeat(40), "g".repeat(40), "a".repeat(39), "a".repeat(41)])(
    "rejects an invalid detached OID %s",
    (oid) => {
      expect(() =>
        decodeCodeEnvironmentObservation({
          ...ready,
          branch: { kind: "detached", oid },
        }),
      ).toThrow();
    },
  );

  it("rejects a ready observation without its changes state", () => {
    const { changes: _, ...withoutChanges } = ready;

    expect(() => decodeCodeEnvironmentObservation(withoutChanges)).toThrow();
  });
});
