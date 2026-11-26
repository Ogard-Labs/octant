import { expect, it } from "vitest";
import { assembleCase } from "./coordinatorEvaluationInput.test-support";
import { cases, compareSamples, score, summarize } from "./coordinatorEvaluation";

it("detects unnecessary starts, missing assignments, duplicate assignments and misdirected sends", () => {
  const start = (prompt: string) => ({ operation: "start", title: prompt, prompt });
  const send = (recipients: string[]) => ({
    operation: "send",
    recipients,
    message: "Use dark blue",
  });
  expect(score(cases.status, [start("status")], "One worker is working.")).toBe(false);
  expect(score(cases.status, [], "One worker is working.")).toBe(true);
  expect(score(cases.assign, [start("parser")], "I assigned both.")).toBe(false);
  expect(score(cases.assign, [start("parser"), start("parser")], "")).toBe(false);
  expect(score(cases.assign, [start("parser"), start("changelog")], "")).toBe(true);
  expect(score(cases.revise, [send([cases.revise.workers[1].reference])], "I sent it.")).toBe(
    false,
  );
  expect(score(cases.revise, [send([cases.revise.workers[0].reference])], "")).toBe(true);
});

it("passes changed orchestration instructions, production roster and offered tool schema to the model", () => {
  const first = assembleCase(cases.revise, "Answer status questions inline.");
  const edited = assembleCase(cases.revise, "Start workers for status questions.");
  expect(first.messages[0]?.content).toContain("Answer status questions inline.");
  expect(first.messages[0]?.content).toContain("The person's orchestration instructions");
  expect(edited.messages[0]?.content).toContain("Start workers for status questions.");
  expect(edited.messages[0]?.content).not.toContain("Answer status questions inline.");
  expect(first.messages[1]?.content).toContain(cases.revise.workers[0].reference);
  expect(first.tools[0]?.function.description).toContain("send takes recipients");
  expect(first.tools[0]?.function.description).toContain("start creates a worker");
});

it("reports incomplete runs and errors separately from completed decisions", () => {
  expect(
    summarize([
      { status: "completed", pass: true, actions: [] },
      { status: "completed", pass: false, actions: [] },
      { status: "incomplete", reason: "length", actions: [] },
      { status: "error", reason: "HTTP 503", actions: [] },
    ]),
  ).toEqual({ samples: 4, passed: 1, failed: 1, errors: 1, incomplete: 1, passRate: 0.5 });
  expect(summarize([]).passRate).toBeNull();
});

it("reports the changes in pass rate and retains the actions for each revision", () => {
  const before = [{ status: "completed", pass: false, actions: [] }] as const;
  const after = [{ status: "completed", pass: true, actions: [{ operation: "start" }] }] as const;
  expect(compareSamples(before, after)).toMatchObject({
    baseline: { runs: before, passRate: 0 },
    candidate: { runs: after, passRate: 1 },
    passRateDelta: 1,
  });
  expect(compareSamples([], after).passRateDelta).toBeNull();
});
