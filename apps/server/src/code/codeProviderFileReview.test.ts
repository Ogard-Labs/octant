import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  decodeProviderModelId,
} from "@octant/contracts";
import type {
  ProviderConnection,
  ProviderDriver,
  ProviderAcquireInput,
  ProviderSessionResume,
} from "@octant/provider-sdk/driver";
import { readCodeProviderFileReviewSession } from "./codeProviderFileReview";

function fixture() {
  const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000001");
  const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000002");
  const calls: string[] = [];
  const acquired: ProviderAcquireInput[] = [];
  const resumed: ProviderSessionResume[] = [];
  const forbidden = () => Effect.die(new Error("A read must not start a prompt or session"));
  const connection: ProviderConnection = {
    subscribe: Effect.succeed(Stream.empty),
    start: forbidden,
    send: forbidden,
    resume: (input) =>
      Effect.sync(() => {
        calls.push("resume");
        resumed.push(input);
        return { sessionId: input.sessionId };
      }),
    readFileReview: () =>
      Effect.sync(() => {
        calls.push("read");
        return {
          status: "ready",
          file: { path: "sample.txt", checkpoint: "", scopes: [], anchors: [] },
        } as const;
      }),
    stop: () =>
      Effect.sync(() => {
        calls.push("stop");
      }),
    interrupt: forbidden,
    answerApproval: forbidden,
    answerUserInput: forbidden,
    answerTool: forbidden,
  };
  const driver: ProviderDriver = {
    kind: "mistral-vibe",
    fileReviewReads: true,
    probe: forbidden,
    acquire: (input) =>
      Effect.gen(function* () {
        calls.push("acquire");
        acquired.push(input);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            calls.push("release");
          }),
        );
        return connection;
      }),
  };
  return {
    calls,
    acquired,
    resumed,
    connection,
    driver,
    input: {
      driver,
      acquire: { instanceId, projectRoot: "/fixture", mode: "code" as const },
      resume: {
        sessionId,
        resumeCursor: { driverKind: "mistral-vibe" as const, value: "host-recorded" },
        modelId: decodeProviderModelId("model"),
        executionPolicy: "approval-gated" as const,
        tools: [],
      },
      path: "sample.txt",
      current: () => true,
    },
  };
}

describe("Code supplementary provider reads", () => {
  it("confines a read below the task's Full native setup and extra-folder authority", async () => {
    const f = fixture();
    const original = {
      ...f.input,
      resume: {
        ...f.input.resume,
        executionPolicy: "full-access" as const,
        autoApprove: true,
        nativeSetup: {
          subagents: true,
          webTools: true,
          skills: true,
          toolServers: true,
          hooks: true,
          projectCode: true,
        },
      },
      acquire: { ...f.input.acquire, extraFolders: ["/unrelated"] },
    };
    expect(await readCodeProviderFileReviewSession(original)).toMatchObject({ status: "ready" });
    expect(f.acquired).toEqual([
      {
        instanceId: f.input.acquire.instanceId,
        projectRoot: "/fixture",
        mode: "code",
        extraFolders: [],
      },
    ]);
    expect(f.resumed).toEqual([
      {
        ...f.input.resume,
        executionPolicy: "plan",
        autoApprove: false,
        nativeSetup: {
          subagents: false,
          webTools: false,
          skills: false,
          toolServers: false,
          hooks: false,
          projectCode: false,
        },
        tools: [],
        current: expect.any(Function),
      },
    ]);
  });
  it("resumes only the host-recorded session, reads and releases without prompting", async () => {
    const f = fixture();
    expect(await readCodeProviderFileReviewSession(f.input)).toMatchObject({
      status: "ready",
      file: { checkpoint: "" },
    });
    expect(f.calls).toEqual(["acquire", "resume", "read", "stop", "release"]);
  });
  it("releases a late acquire without resuming after authority expires", async () => {
    const f = fixture();
    let current = true;
    const driver = {
      ...f.driver,
      acquire: () =>
        f.driver.acquire(f.input.acquire).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              current = false;
            }),
          ),
        ),
    };
    expect(
      await readCodeProviderFileReviewSession({ ...f.input, driver, current: () => current }),
    ).toEqual({ status: "refused", reason: "stale" });
    expect(f.calls).toEqual(["acquire", "stop", "release"]);
  });
  it("distinguishes a cold resume refusal and does not fall back to a new session", async () => {
    const f = fixture();
    const driver = {
      ...f.driver,
      acquire: () =>
        Effect.succeed({
          ...f.connection,
          resume: () =>
            Effect.fail({
              _tag: "ProviderFailure" as const,
              category: "stale-resume" as const,
              message: "Missing",
            }),
        }),
    };
    expect(await readCodeProviderFileReviewSession({ ...f.input, driver })).toEqual({
      status: "refused",
      reason: "cold-unavailable",
    });
    expect(f.calls).toEqual(["stop"]);
  });
  it("withholds late content and closes the acquired session", async () => {
    const f = fixture();
    let current = true;
    const driver = {
      ...f.driver,
      acquire: () =>
        Effect.succeed({
          ...f.connection,
          readFileReview: () =>
            Effect.sync(() => {
              current = false;
              return {
                status: "ready",
                file: { path: "sample.txt", checkpoint: "private", scopes: [], anchors: [] },
              } as const;
            }),
        }),
    };
    expect(
      await readCodeProviderFileReviewSession({ ...f.input, driver, current: () => current }),
    ).toEqual({ status: "refused", reason: "stale" });
    expect(f.calls).toEqual(["resume", "stop"]);
  });
  it("bounds a suspended acquisition and releases resources registered before it answered", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const driver = {
        ...f.driver,
        acquire: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                f.calls.push("release-partial");
              }),
            );
            return yield* Effect.never;
          }),
      };
      const pending = readCodeProviderFileReviewSession({ ...f.input, driver });
      await vi.advanceTimersByTimeAsync(12_001);
      expect(await pending).toEqual({ status: "refused", reason: "timeout" });
      expect(f.calls).toEqual(["release-partial"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled read and still stops and releases its connection", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const driver = {
        ...f.driver,
        acquire: () =>
          f.driver
            .acquire(f.input.acquire)
            .pipe(Effect.map((c) => ({ ...c, readFileReview: () => Effect.never }))),
      };
      const pending = readCodeProviderFileReviewSession({ ...f.input, driver });
      await vi.advanceTimersByTimeAsync(12_001);
      expect(await pending).toEqual({ status: "refused", reason: "timeout" });
      expect(f.calls).toEqual(["acquire", "resume", "stop", "release"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
