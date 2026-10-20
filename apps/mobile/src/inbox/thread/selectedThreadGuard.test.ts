import { describe, expect, it } from "vitest";
import { createSelectedThreadGuard } from "./selectedThreadGuard";

describe("selected thread guard", () => {
  it("keeps the result of work for the thread that is still selected", async () => {
    const guard = createSelectedThreadGuard();
    guard.select("host:a");

    const result = await guard.guarded("host:a", async () => "reply");

    expect(result).toEqual({ status: "done", value: "reply" });
  });

  it("drops the result when another thread was selected while the work ran", async () => {
    const guard = createSelectedThreadGuard();
    guard.select("host:a");

    const result = await guard.guarded("host:a", async () => {
      guard.select("host:b");
      return "reply for a";
    });

    expect(result).toEqual({ status: "stale" });
  });

  it("drops a failure that arrives after the selection moved on", async () => {
    const guard = createSelectedThreadGuard();
    guard.select("host:a");

    const result = await guard.guarded("host:a", async () => {
      guard.select(undefined);
      throw new Error("late");
    });

    expect(result).toEqual({ status: "stale" });
  });

  it("reports a failure for the selected thread as a value", async () => {
    const guard = createSelectedThreadGuard();
    guard.select("host:a");
    const cause = new Error("refused");

    const result = await guard.guarded("host:a", async () => {
      throw cause;
    });

    expect(result).toEqual({ status: "failed", cause });
  });

  it("drops work from an earlier visit after returning to the same thread", async () => {
    const guard = createSelectedThreadGuard();
    guard.select("host:a");

    const result = await guard.guarded("host:a", async () => {
      guard.select("host:b");
      guard.select("host:a");
      return "old";
    });

    expect(result).toEqual({ status: "stale" });
  });

  it("keeps overlapping work for the same thread", async () => {
    const guard = createSelectedThreadGuard();
    guard.select("host:a");
    guard.select("host:a");

    const [first, second] = await Promise.all([
      guard.guarded("host:a", async () => 1),
      guard.guarded("host:a", async () => 2),
    ]);

    expect([first.status, second.status]).toEqual(["done", "done"]);
  });
});
