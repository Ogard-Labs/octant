import { describe, expect, it } from "vitest";
import { workTurnToolLevel } from "./workTurnToolLevel";

describe("a Work turn's own tools at its level", () => {
  it("refuses every write family in Plan and keeps the reads", () => {
    const plan = workTurnToolLevel("plan");
    // Browser and Computer are composed at Plan, which admits only reads of
    // the page already open and refuses every Computer action; sibling
    // messages, routines and helpers read the Plan posture at each call.
    expect(plan).toMatchObject({ composed: "plan", posture: "plan", imageSave: "refuse" });
    expect(plan.imageRefusal).toMatch(/Plan mode cannot generate images/);
    expect(plan.memoryRefusal).toMatch(/Plan mode cannot change Project memory/);
  });

  it("leaves every other level to the families' own asks, as before Plan existed", () => {
    for (const access of ["ask-first", "auto"] as const) {
      expect(workTurnToolLevel(access)).toEqual({
        posture: "approval-gated",
        composed: "approval-gated",
        imageSave: "ask",
      });
    }
    expect(workTurnToolLevel("auto-accept-edits")).toMatchObject({ imageSave: "allow" });
    expect(workTurnToolLevel("full-access")).toEqual({
      posture: "full-access",
      composed: "approval-gated",
      imageSave: "allow",
    });
    // No turn running asks for every effect.
    expect(workTurnToolLevel(undefined)).toMatchObject({ imageSave: "ask" });
  });
});
