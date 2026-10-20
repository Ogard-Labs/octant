import { describe, expect, it } from "vitest";
import { WORK_THREAD_NOT_LOADED, workFollowUpTarget } from "./workFollowUpTarget";

function thread(id: string) {
  return { id };
}

describe("work follow-up target", () => {
  it("explains that the thread is not loaded when nothing has loaded yet", () => {
    expect(workFollowUpTarget(undefined, "w1")).toEqual({
      status: "not-loaded",
      message: WORK_THREAD_NOT_LOADED,
    });
  });

  it("explains that the thread is not loaded when another thread's data is still mounted", () => {
    expect(workFollowUpTarget(thread("w2"), "w1").status).toBe("not-loaded");
  });

  it("allows a follow-up on the loaded, selected thread", () => {
    const loaded = thread("w1");

    expect(workFollowUpTarget(loaded, "w1")).toEqual({ status: "ready", thread: loaded });
  });
});
