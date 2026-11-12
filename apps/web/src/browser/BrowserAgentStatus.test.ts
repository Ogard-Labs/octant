import { expect, it } from "vitest";
import { agentAvailabilityNote } from "./BrowserAgentStatus";

it("names admission, Plan and unknown states without offering a new permission", () => {
  expect(agentAvailabilityNote({ status: "available", readOnly: false })).toEqual({
    message: "Agent can use this Browser.",
  });
  expect(agentAvailabilityNote({ status: "available", readOnly: true }).message).toBe(
    "Agent can read this Browser in Plan.",
  );
  expect(agentAvailabilityNote(undefined)).toEqual({
    message: "Browser availability is unknown.",
  });
});

it.each([
  ["no-tool-transport", "Choose provider"],
  ["excluded-by-thread-constraints", "Review task access"],
  ["host-lends-no-browser", "Check host settings"],
] as const)("keeps the specific omission and its recovery action: %s", (reason, remedy) => {
  const note = agentAvailabilityNote({ status: "omitted", reason });
  expect(note.message).toMatch(/The agent cannot use this Browser/);
  expect(note.omission).toBe(reason);
  expect(note.remedy).toBe(remedy);
});
