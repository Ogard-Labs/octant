import { describe, expect, it } from "vitest";
import { readAcpFileReview } from "./acpFileReview";

function fixture(options: { readonly scopeId?: string; readonly current?: () => boolean } = {}) {
  const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
  const invoke = (method: string) => {
    if (method === "_review/state")
      return {
        files: [{ path: "sample.txt" }],
        scopes: [{ owner: { kind: "manual", index: 0 }, files: [{ path: "sample.txt" }] }],
      };
    if (method === "_review/baseline") return { content: "checkpoint\n" };
    if (method === "_review/turnDiff")
      return { status: "created", baseline: "", current: "fixture\n" };
    if (method === "_review/hunks")
      return { hunks: [{ side: "additions", line: 0, cwd: "/private/fixture-root", regions: [] }] };
    throw new Error("Unexpected mutation or method");
  };
  return {
    calls,
    input: {
      runtimeVersion: "3.0.3",
      sourceSessionId: "native-session",
      path: "sample.txt",
      current: options.current ?? (() => true),
      ...(options.scopeId === undefined ? {} : { scopeId: options.scopeId }),
      call: async (method: string, params: Readonly<Record<string, unknown>>) => {
        calls.push({ method, params });
        return invoke(method);
      },
    },
  };
}

describe("supplementary ACP file review reads", () => {
  it("uses only the owned session's read methods and strips native host paths", async () => {
    const f = fixture();
    const result = await readAcpFileReview(f.input);
    expect(result).toEqual({
      status: "ready",
      file: {
        path: "sample.txt",
        checkpoint: "checkpoint\n",
        scopes: [{ id: "manual:0", label: "Manual edit 1", source: "manual-edit" }],
        comparison: { scopeId: "manual:0", change: "created", before: "", after: "fixture\n" },
        anchors: [{ side: "after", line: 1 }],
      },
    });
    expect(f.calls.map((call) => call.method)).toEqual([
      "_review/hunks",
      "_review/state",
      "_review/baseline",
      "_review/turnDiff",
      "_review/hunks",
    ]);
    expect(f.calls.every((call) => call.params.sessionId === "native-session")).toBe(true);
    expect(f.calls.find((call) => call.method === "_review/turnDiff")?.params.owner).toEqual({
      kind: "manual",
      index: 0,
    });
    expect(JSON.stringify(result)).not.toContain("/private/");
  });

  it("refuses an unverified release, escaping path or unobserved scope before scoped reads", async () => {
    const f = fixture({ scopeId: "native-turn:999" });
    expect(await readAcpFileReview({ ...f.input, runtimeVersion: "3.0.4" })).toEqual({
      status: "refused",
      reason: "unsupported",
    });
    expect(await readAcpFileReview({ ...f.input, path: "../secret" })).toEqual({
      status: "refused",
      reason: "path-refused",
    });
    expect(f.calls).toEqual([]);
    expect(await readAcpFileReview(f.input)).toEqual({ status: "refused", reason: "stale" });
    expect(f.calls.some((call) => call.method === "_review/turnDiff")).toBe(false);
  });

  it("does not dispatch a native read cancelled before its queued transport call", async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = readAcpFileReview({ ...f.input, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ status: "refused", reason: "cancelled" });
    expect(f.calls).toEqual([]);
  });

  it("normalizes a transport that throws before returning a promise", async () => {
    const f = fixture();
    expect(
      await readAcpFileReview({
        ...f.input,
        call: () => {
          throw new Error("closed");
        },
      }),
    ).toEqual({ status: "refused", reason: "unavailable" });
  });

  it("withholds late content after authority changes and distinguishes malformed data", async () => {
    let current = true;
    const f = fixture({ current: () => current });
    expect(
      await readAcpFileReview({
        ...f.input,
        call: async () => {
          current = false;
          return { content: "private" };
        },
      }),
    ).toEqual({ status: "refused", reason: "stale" });
    current = true;
    expect(
      await readAcpFileReview({
        ...f.input,
        call: async () => ({ hunks: [{ side: "additions", line: -1 }] }),
      }),
    ).toEqual({ status: "refused", reason: "malformed" });
    const controller = new AbortController();
    controller.abort();
    expect(await readAcpFileReview({ ...f.input, signal: controller.signal })).toEqual({
      status: "refused",
      reason: "cancelled",
    });
  });
});
