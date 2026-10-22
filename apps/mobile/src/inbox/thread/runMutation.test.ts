import { describe, expect, it } from "vitest";
import { runLoad, runMutation, sendThenReload } from "./runMutation";
import { createSelectedThreadGuard } from "./selectedThreadGuard";
import type { MutationGate, ThreadUi } from "./threadTypes";

function recorder() {
  const calls: Array<string> = [];
  const ui: ThreadUi = {
    setBusy: (busy) => calls.push(`busy:${busy}`),
    setError: (message) => calls.push(`error:${message ?? "none"}`),
  };
  return { calls, ui };
}

const open: MutationGate = { allowProductMutations: true, message: "" };

describe("run mutation", () => {
  it("paints the result of a send that finished on the selected thread", async () => {
    const guard = createSelectedThreadGuard();
    guard.select("h:a");
    const { calls, ui } = recorder();
    const painted: Array<string> = [];

    const outcome = await runMutation({
      guard,
      identity: "h:a",
      gate: open,
      ui,
      failure: "Follow-up failed.",
      run: async () => "reply",
      onDone: (value) => painted.push(value),
    });

    expect(outcome).toBe("done");
    expect(painted).toEqual(["reply"]);
    expect(calls).toEqual(["busy:true", "error:none", "busy:false"]);
  });

  it("paints nothing when the thread changed during the send", async () => {
    const guard = createSelectedThreadGuard();
    guard.select("h:a");
    const { calls, ui } = recorder();
    const painted: Array<string> = [];

    const outcome = await runMutation({
      guard,
      identity: "h:a",
      gate: open,
      ui,
      failure: "Follow-up failed.",
      run: async () => {
        guard.select("h:b");
        return "reply for a";
      },
      onDone: (value) => painted.push(value),
    });

    expect(outcome).toBe("stale");
    expect(painted).toEqual([]);
    expect(calls).toEqual(["busy:true", "error:none"]);
  });

  it("shows the stale-host message and starts nothing while the host is stale", async () => {
    const guard = createSelectedThreadGuard();
    guard.select("h:a");
    const { calls, ui } = recorder();
    let ran = false;

    const outcome = await runMutation({
      guard,
      identity: "h:a",
      gate: { allowProductMutations: false, message: "Reads only." },
      ui,
      failure: "x",
      run: async () => {
        ran = true;
      },
      onDone: () => undefined,
    });

    expect(outcome).toBe("refused");
    expect(ran).toBe(false);
    expect(calls).toEqual(["error:Reads only."]);
  });

  it("shows the fallback message when the host failure is not a host answer", async () => {
    const guard = createSelectedThreadGuard();
    guard.select("h:a");
    const { calls, ui } = recorder();

    const outcome = await runMutation({
      guard,
      identity: "h:a",
      gate: open,
      ui,
      failure: "Stop failed.",
      run: async () => {
        throw new Error("boom");
      },
      onDone: () => undefined,
    });

    expect(outcome).toBe("failed");
    expect(calls).toContain("error:Stop failed.");
  });
});

describe("send then reload", () => {
  it("clears the submitted draft and reports done when the reload after an accepted send fails", async () => {
    const guard = createSelectedThreadGuard();
    guard.select("h:a");
    const { calls, ui } = recorder();
    let draft = "hello";

    const outcome = await runMutation({
      guard,
      identity: "h:a",
      gate: open,
      ui,
      failure: "Follow-up failed.",
      run: () =>
        sendThenReload({
          send: async () => undefined,
          onSent: () => {
            draft = "";
          },
          reload: async () => {
            throw new Error("offline");
          },
        }),
      onDone: () => undefined,
    });

    expect(outcome).toBe("done");
    expect(draft).toBe("");
    expect(calls).not.toContain("error:Follow-up failed.");
  });

  it("keeps the draft and fails when the send itself is refused", async () => {
    let draft = "hello";
    await expect(
      sendThenReload({
        send: async () => {
          throw new Error("rejected");
        },
        onSent: () => {
          draft = "";
        },
        reload: async () => "view",
      }),
    ).rejects.toThrow("rejected");
    expect(draft).toBe("hello");
  });
});

describe("run load", () => {
  it("stays silent when a quiet reload fails", async () => {
    const guard = createSelectedThreadGuard();
    guard.select("h:a");
    const { calls, ui } = recorder();

    await runLoad({
      guard,
      identity: "h:a",
      quiet: true,
      ui,
      failure: "Could not load the thread.",
      load: async () => {
        throw new Error("offline");
      },
      onLoaded: () => undefined,
      onFailed: () => calls.push("cleared"),
    });

    expect(calls).toEqual([]);
  });
});
