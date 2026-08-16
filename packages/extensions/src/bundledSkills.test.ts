import { describe, expect, it } from "vitest";
import {
  REVIEW_IN_PARALLEL_SKILL_NAME,
  bundledSkillRecords,
  reviewInParallelSkillContent,
  reviewInParallelSkillRecord,
} from "./bundledSkills";

describe("bundled skills", () => {
  it("ships the review-in-parallel skill with bundled source kind", () => {
    const record = reviewInParallelSkillRecord();
    expect(record.skill.name).toBe(REVIEW_IN_PARALLEL_SKILL_NAME);
    expect(record.skill.sourceKind).toBe("bundled");
    expect(record.source).toEqual({ kind: "bundled", sourceRef: "app:review-in-parallel" });
    expect(record.desiredEnabled).toBe(true);
    expect(record.effectiveState).toEqual({ kind: "effective" });
  });

  it("describes linked-thread fan-out instead of AgentRun semantics", () => {
    const content = reviewInParallelSkillContent();
    expect(content).toContain("linked-thread");
    expect(content).toContain("not an AgentRun");
    expect(content).toContain("read-only");
  });

  it("exposes a stable bundled catalog entry", () => {
    expect(bundledSkillRecords().map((record) => record.skill.name)).toEqual([
      REVIEW_IN_PARALLEL_SKILL_NAME,
    ]);
  });
});
