import type { AutomationDefinition, AutomationRun, Project } from "@octant/contracts";
import { describe, expect, it } from "vitest";

import { standingMergeAllowanceFor } from "./standingMergeAllowance";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const thread = { projectId } as never;

const project = (agentMerge?: "enabled" | "disabled") =>
  ({ type: "code", id: projectId, ...(agentMerge === undefined ? {} : { agentMerge }) }) as Project;
const run = (overrides: Record<string, unknown> = {}) =>
  ({
    definitionSnapshot: {
      agentMerge: "allowed",
      mode: "code",
      targetPolicy: "new-thread",
      projectId,
      ...overrides,
    },
  }) as unknown as AutomationRun;
const routine = (overrides: Record<string, unknown> = {}) =>
  ({
    agentMerge: "allowed",
    lifecycle: "enabled",
    projectId,
    ...overrides,
  }) as unknown as AutomationDefinition;

describe("standing merge allowance", () => {
  it("allows nothing until the person stored a choice", () => {
    expect(
      standingMergeAllowanceFor({ thread, project: project(), run: undefined, routine: undefined }),
    ).toEqual([]);
    expect(
      standingMergeAllowanceFor({
        thread,
        project: project("disabled"),
        run: run({ agentMerge: undefined }),
        routine: routine({ agentMerge: undefined }),
      }),
    ).toEqual([]);
  });

  it("names the Project setting and the routine that each allow the merge", () => {
    expect(
      standingMergeAllowanceFor({
        thread,
        project: project("enabled"),
        run: run(),
        routine: routine(),
      }),
    ).toEqual(["project", "routine"]);
  });

  it("stops honoring a routine once it is paused, revised, or no longer this Project's new-thread run", () => {
    const base = { thread, project: undefined };
    for (const input of [
      { run: run(), routine: routine({ lifecycle: "paused" }) },
      { run: run(), routine: routine({ agentMerge: undefined }) },
      { run: run(), routine: routine({ projectId: otherProjectId }) },
      { run: run({ projectId: otherProjectId }), routine: routine() },
      { run: run({ targetPolicy: "same-thread" }), routine: routine() },
      { run: run({ mode: "work" }), routine: routine() },
      { run: run({ agentMerge: undefined }), routine: routine() },
    ]) {
      expect(standingMergeAllowanceFor({ ...base, ...input })).toEqual([]);
    }
  });
});
