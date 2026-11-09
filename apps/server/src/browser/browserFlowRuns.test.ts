import { describe, expect, it, vi } from "vitest";
import {
  decodeBrowserFlow,
  decodeProjectId,
  decodeWindowId,
  decodeBrowserThreadId,
} from "@octant/contracts";
import { BrowserFlowRuns } from "./browserFlowRuns";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const windowId = decodeWindowId("10000000-0000-4000-8000-000000000002");
const otherWindow = decodeWindowId("10000000-0000-4000-8000-000000000003");
const task = {
  threadId: decodeBrowserThreadId("10000000-0000-4000-8000-000000000004"),
  mode: "code" as const,
  title: "Check form",
  modelId: "synthetic-model" as never,
  accessLabel: "Ask first",
  profileLabel: "Private",
};
function fixture() {
  let flow = decodeBrowserFlow({
    name: "Fill form",
    savedAt: "2026-11-07T10:00:00.000Z",
    steps: [
      {
        operation: "type",
        input: { operation: "type", ref: "e1", text: "recorded" },
        targets: { ref: { role: "textbox", name: "Message" } },
        expect: { path: "/form" },
      },
      {
        operation: "click",
        input: { operation: "click", ref: "e2" },
        targets: { ref: { role: "button", name: "Send" } },
        expect: { path: "/sent" },
      },
    ],
  });
  let fingerprint = "current-authority-model-profile-grants";
  let now = 0;
  let held = false;
  let sites = "original-sites";
  const released = vi.fn();
  const execute = vi.fn(async (step: { readonly operation: string }) =>
    held
      ? { isError: true, result: { error: "browser-waiting-for-person" } }
      : {
          isError: false,
          result: {
            page: { url: `https://fixture.test/${step.operation === "click" ? "sent" : "form"}` },
          },
        },
  );
  const service = new BrowserFlowRuns({
    readFlow: () => flow,
    tasks: () => [task],
    bindTask: () => ({
      fingerprint,
      resumeFingerprint: sites,
      refs: () => [
        { ref: "e1", role: "textbox", name: "Message", selector: "#message" },
        { ref: "e2", role: "button", name: "Send", selector: "#send" },
      ],
      execute,
      claim: () => ({ release: released }),
    }),
    uuid: () => "10000000-0000-4000-8000-000000000005",
    now: () => now,
  });
  return {
    service,
    execute,
    released,
    changeAuthority: () => {
      fingerprint = "changed";
    },
    changeFlow: () => {
      flow = decodeBrowserFlow({ ...flow, savedAt: "2026-11-07T11:00:00.000Z" });
    },
    hold: () => {
      held = true;
    },
    handBack: () => {
      held = false;
    },
    changeSites: () => {
      sites = "changed-sites";
    },
    expire: () => {
      now = 900_001;
    },
  };
}

describe("reviewed Browser flow runs", () => {
  it("reviews fixed steps without effects and keeps edited values out of the saved flow", async () => {
    const f = fixture();
    const review = f.service.review(windowId, projectId, "Fill form", task);
    expect(review.kind).toBe("browser-flow-run");
    expect(f.execute).not.toHaveBeenCalled();
    if (review.kind !== "browser-flow-run") return;
    await f.service.start(windowId, review.run.id, [{ step: 0, text: "this run only" }]);
    await vi.waitFor(() =>
      expect(f.service.inspect(windowId, review.run.id)).toMatchObject({
        run: { state: "completed" },
      }),
    );
    expect(f.execute).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "type", text: "this run only" }),
      expect.any(AbortSignal),
    );
    expect(f.service.inspect(windowId, review.run.id)).toMatchObject({
      run: { state: "completed", completed: 2 },
    });
    expect(f.service.review(windowId, projectId, "Fill form", task)).toMatchObject({
      run: {
        flow: {
          steps: [
            expect.objectContaining({ input: expect.objectContaining({ text: "recorded" }) }),
            expect.anything(),
          ],
        },
      },
    });
    expect(f.released).toHaveBeenCalledOnce();
  });

  it("requires the reviewing local window, unchanged authority and a fresh flow before starting", async () => {
    const f = fixture();
    const review = f.service.review(windowId, projectId, "Fill form", task);
    if (review.kind !== "browser-flow-run") throw Error("review refused");
    expect(await f.service.start(otherWindow, review.run.id, [])).toMatchObject({
      kind: "browser-flows-refused",
    });
    f.changeAuthority();
    expect(await f.service.start(windowId, review.run.id, [])).toMatchObject({
      kind: "browser-flows-refused",
    });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("pauses only before an unexecuted human-held step and requires explicit current Resume", async () => {
    const f = fixture();
    f.hold();
    const review = f.service.review(windowId, projectId, "Fill form", task);
    if (review.kind !== "browser-flow-run") throw Error("review refused");
    await f.service.start(windowId, review.run.id, []);
    await vi.waitFor(() =>
      expect(f.service.inspect(windowId, review.run.id)).toMatchObject({
        run: { state: "paused" },
      }),
    );
    expect(f.service.inspect(windowId, review.run.id)).toMatchObject({
      run: { state: "paused", completed: 0 },
    });
    f.handBack();
    expect(f.execute).toHaveBeenCalledTimes(1);
    f.changeFlow();
    expect(await f.service.resume(windowId, review.run.id)).toMatchObject({
      kind: "browser-flows-refused",
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("resumes a human-held step once with its reviewed values and releases custody", async () => {
    const f = fixture();
    f.hold();
    const review = f.service.review(windowId, projectId, "Fill form", task);
    if (review.kind !== "browser-flow-run") throw Error("review refused");
    await f.service.start(windowId, review.run.id, [{ step: 0, text: "run value" }]);
    await vi.waitFor(() =>
      expect(f.service.inspect(windowId, review.run.id)).toMatchObject({
        run: { state: "paused" },
      }),
    );
    expect(f.released).not.toHaveBeenCalled();
    f.handBack();
    await f.service.resume(windowId, review.run.id);
    await vi.waitFor(() =>
      expect(f.service.inspect(windowId, review.run.id)).toMatchObject({
        run: { state: "completed", completed: 2 },
      }),
    );
    expect(f.execute.mock.calls.filter(([step]) => step.operation === "type")).toHaveLength(1);
    expect(f.released).toHaveBeenCalledOnce();
    f.service.close();
  });

  it("invalidates Resume after site approval changes without retrying the held step", async () => {
    const f = fixture();
    f.hold();
    const review = f.service.review(windowId, projectId, "Fill form", task);
    if (review.kind !== "browser-flow-run") throw Error("review refused");
    await f.service.start(windowId, review.run.id, []);
    await vi.waitFor(() =>
      expect(f.service.inspect(windowId, review.run.id)).toMatchObject({
        run: { state: "paused" },
      }),
    );
    f.changeSites();
    f.handBack();
    expect(await f.service.resume(windowId, review.run.id)).toMatchObject({
      kind: "browser-flows-refused",
      reason: "run-stale",
    });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.released).toHaveBeenCalledOnce();
    f.service.close();
  });

  it("expires a review without executing and refuses a value for a fixed click", async () => {
    const f = fixture();
    const review = f.service.review(windowId, projectId, "Fill form", task);
    if (review.kind !== "browser-flow-run") throw Error("review refused");
    expect(
      await f.service.start(windowId, review.run.id, [{ step: 1, text: "not a type step" }]),
    ).toMatchObject({ kind: "browser-flows-refused" });
    f.expire();
    expect(await f.service.start(windowId, review.run.id, [])).toMatchObject({
      kind: "browser-flows-refused",
    });
    expect(f.execute).not.toHaveBeenCalled();
  });
});
