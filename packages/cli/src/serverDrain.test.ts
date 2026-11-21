import { describe, expect, it } from "vitest";
import type { HostDrainStatus } from "@octant/contracts/host-control";
import type { LocalControlRequest, LocalControlResponse } from "./localControl";
import { resolveServerDrainCliCommand, runServerDrainCliCommand } from "./serverDrain";

/** A host whose drain answers each request with the next status in turn. */
function host(answers: ReadonlyArray<HostDrainStatus | LocalControlResponse>) {
  const seen: unknown[] = [];
  let at = 0;
  const send = async (request: LocalControlRequest): Promise<LocalControlResponse> => {
    expect(request).toMatchObject({ path: "/api/host-control/drain", method: "POST" });
    seen.push(request.body);
    const answer = answers[Math.min(at, answers.length - 1)];
    at += 1;
    if (answer === undefined) throw new Error("The stand-in host has nothing to answer.");
    return "status" in answer ? answer : { status: 200, body: answer };
  };
  const out: string[] = [];
  const err: string[] = [];
  return {
    seen,
    run: (command: NonNullable<ReturnType<typeof resolveServerDrainCliCommand>>) =>
      runServerDrainCliCommand({
        command,
        session: { send },
        stdout: { write: (chunk: string) => out.push(chunk) },
        stderr: { write: (chunk: string) => err.push(chunk) },
        sleep: async () => undefined,
      }),
    out,
    err,
  };
}

describe("octant server drain", () => {
  it("server drain reports drained once running turns end, and timed-out with a count when they don't", async () => {
    const drained = host([
      { state: "draining", running: 2 },
      { state: "draining", running: 1 },
      { state: "drained" },
    ]);
    expect(await drained.run({ action: "wait", minutes: 10 })).toBe(0);
    expect(drained.seen).toEqual([
      { action: "drain", minutes: 10 },
      { action: "read" },
      { action: "read" },
    ]);
    expect(drained.out.at(-1)).toMatch(/^drained: no turn is running\./);

    const slow = host([
      { state: "draining", running: 2 },
      { state: "timed-out", running: 2 },
    ]);
    expect(await slow.run({ action: "wait", minutes: 3 })).toBe(0);
    expect(slow.out.at(-1)).toMatch(/^timed-out: 2 turns still running after 3 minutes\./);
  });

  it("says what the host refused, and that a drain lifted mid-wait stopped nothing", async () => {
    const refused = host([{ status: 403, body: { error: "Host control is unauthorized." } }]);
    expect(await refused.run({ action: "wait", minutes: 10 })).toBe(1);
    expect(refused.err).toEqual(["Host control is unauthorized.\n"]);

    const lifted = host([{ state: "draining", running: 1 }, { state: "not-draining" }]);
    expect(await lifted.run({ action: "wait", minutes: 10 })).toBe(1);
    expect(lifted.err.join("")).toContain("Nothing was stopped");

    const lift = host([{ state: "not-draining" }]);
    expect(await lift.run({ action: "lift" })).toBe(0);
    expect(lift.seen).toEqual([{ action: "lift" }]);
  });

  it("takes a wait of 1 to 60 minutes, or --lift, and nothing else", () => {
    expect(resolveServerDrainCliCommand(["drain"], { wait: "10" })).toEqual({
      action: "wait",
      minutes: 10,
    });
    expect(resolveServerDrainCliCommand(["drain"], { lift: true })).toEqual({ action: "lift" });
    for (const flags of [
      {},
      { wait: "0" },
      { wait: "61" },
      { wait: true },
      { wait: "5", lift: true },
    ]) {
      expect(resolveServerDrainCliCommand(["drain"], flags)).toBeUndefined();
    }
  });
});
