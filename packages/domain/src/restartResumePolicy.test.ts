import { describe, expect, it } from "vitest";
import { resumesRecoveryUnattended } from "./restartResumePolicy";

const certain = {
  settingOn: true,
  standing: "answer-dropped",
  resumedUnattendedBefore: false,
} as const;

describe("resuming after a restart with nobody there", () => {
  it("resumes a session the restart found with nothing running", () => {
    expect(resumesRecoveryUnattended(certain)).toEqual({ kind: "resume" });
  });

  it("changes nothing while the setting is off", () => {
    expect(resumesRecoveryUnattended({ ...certain, settingOn: false })).toEqual({
      kind: "wait",
      reason: "setting-off",
    });
  });

  it("never resumes a turn the restart cut off, whose last effect cannot be established", () => {
    expect(resumesRecoveryUnattended({ ...certain, standing: "turn-cut-off" })).toEqual({
      kind: "wait",
      reason: "effect-uncertain",
    });
  });

  it("waits for a person when the last resume was already unattended", () => {
    expect(resumesRecoveryUnattended({ ...certain, resumedUnattendedBefore: true })).toEqual({
      kind: "wait",
      reason: "resumed-once",
    });
  });
});
