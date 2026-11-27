import { type ChatAttemptOutcome, decodeWorkTurnRequestId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  chatVisitorState,
  codeVisitorState,
  visitorThreadSource,
  workVisitorState,
  type WorkVisitorThreads,
} from "./visitorThreadSources";

const ran = (outcome: ChatAttemptOutcome) => ({ outcome, usageLimitStop: false });
const limitStop = { outcome: "waiting", usageLimitStop: true } as const;

describe("a visitor's thread state follows the run, not the messages", () => {
  it("reads a Chat reply still streaming as working, and a turn stopped before it replied as idle", () => {
    expect(chatVisitorState([ran("queued")], false)).toBe("working");
    expect(chatVisitorState([ran("streaming")], false)).toBe("working");
    expect(chatVisitorState([ran("interrupted")], false)).toBe("idle");
    expect(chatVisitorState([ran("cancelled")], false)).toBe("idle");
    expect(chatVisitorState([ran("failed")], false)).toBe("idle");
    expect(chatVisitorState([ran("completed")], false)).toBe("idle");
    expect(chatVisitorState([ran("waiting")], false)).toBe("owner-deciding");
    expect(chatVisitorState([undefined], false)).toBe("idle");
    expect(chatVisitorState([], false)).toBe("idle");
  });

  it("reads a regenerated older Chat reply as working even when the last turn is done", () => {
    expect(chatVisitorState([ran("streaming"), ran("completed")], false)).toBe("working");
  });

  it("reads a question from a regenerated older reply as the owner deciding", () => {
    expect(chatVisitorState([ran("waiting"), ran("completed")], false)).toBe("owner-deciding");
  });

  it("reads a usage-limit stop as the owner deciding only while it is the last turn's and not released", () => {
    expect(chatVisitorState([ran("completed"), limitStop], false)).toBe("owner-deciding");
    expect(chatVisitorState([ran("completed"), limitStop], true)).toBe("idle");
    expect(chatVisitorState([limitStop, ran("completed")], false)).toBe("idle");
  });

  it("reads a Code turn still executing as working, and one stopped before it replied as idle", () => {
    expect(codeVisitorState("active", { executing: true, awaitingInput: false })).toBe("working");
    expect(codeVisitorState("active", { executing: false, awaitingInput: false })).toBe("idle");
    expect(codeVisitorState("active", {})).toBe("idle");
    expect(codeVisitorState("active", { executing: false, awaitingInput: true })).toBe(
      "owner-deciding",
    );
    expect(codeVisitorState("waiting", { executing: false })).toBe("owner-deciding");
  });
});

describe("a Work thread as a visitor reads it", () => {
  const idle = { executing: false, awaitingInput: false };

  it("reads a Work turn still executing as working, a question or approval as the owner deciding, and a stopped turn as idle", () => {
    expect(workVisitorState({ executing: true, awaitingInput: false }, undefined, false)).toBe(
      "working",
    );
    expect(workVisitorState({ executing: false, awaitingInput: true }, undefined, false)).toBe(
      "owner-deciding",
    );
    expect(workVisitorState({ executing: true, awaitingInput: true }, undefined, false)).toBe(
      "owner-deciding",
    );
    expect(workVisitorState(idle, undefined, false)).toBe("idle");
  });

  it("reads a usage-limit stop as the owner deciding only while no move to another account released it", () => {
    const parked = { executing: false, awaitingInput: true, waitsOnTurnAlone: true } as const;
    expect(workVisitorState(parked, { usageLimitStop: true }, false)).toBe("owner-deciding");
    expect(workVisitorState(parked, { usageLimitStop: true }, true)).toBe("idle");
    // A released stop does not hide a request that is open beside it.
    expect(
      workVisitorState({ executing: false, awaitingInput: true }, { usageLimitStop: true }, true),
    ).toBe("owner-deciding");
  });

  const unusedConnection = () => {
    throw new Error("A Work read uses no database.");
  };

  function workThreads(overrides: Partial<WorkVisitorThreads> = {}): WorkVisitorThreads {
    const turn = {
      requestId: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      turnId: "turn-1",
      status: "completed",
      transcript: [
        { role: "user", text: "Summarise the contract in /Users/ada/Contracts/acme.pdf" },
        { role: "assistant", text: "It runs for two years." },
      ],
      // Never part of what a visitor reads.
      toolSteps: [{ name: "read_file", state: "completed", message: "TOOL OUTPUT: clause 7" }],
      wroteFiles: { paths: ["/Users/ada/Contracts/summary.md"], truncated: false },
      response: "It runs for two years.",
    } as const;
    return {
      thread: () => ({ title: "Read the Acme contract", lifecycle: "active" }),
      turns: () => [turn],
      liveReplyText: () => undefined,
      activity: () => idle,
      ...overrides,
    };
  }

  it("shows a Work thread's messages and state, and never its tool output or files", () => {
    const source = visitorThreadSource(unusedConnection, () => ({}), workThreads());
    const read = source.read("work", "11111111-1111-4111-8111-111111111111");
    expect(read).toEqual({
      status: "found",
      title: "Read the Acme contract",
      archived: false,
      state: "idle",
      messages: [
        { role: "person", text: "Summarise the contract in /Users/ada/Contracts/acme.pdf" },
        { role: "agent", text: "It runs for two years." },
      ],
    });
    expect(JSON.stringify(read)).not.toContain("TOOL OUTPUT");
    expect(JSON.stringify(read)).not.toContain("summary.md");
  });

  it("shows the reply a running Work turn has streamed so far", () => {
    const source = visitorThreadSource(
      unusedConnection,
      () => ({}),
      workThreads({
        turns: () => [
          {
            requestId: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            turnId: "turn-1",
            status: "running",
            transcript: [
              { role: "user", text: "Summarise it" },
              { role: "assistant", text: "" },
            ],
          },
        ],
        liveReplyText: () => "It runs for",
        activity: () => ({ executing: true, awaitingInput: false }),
      }),
    );
    expect(source.read("work", "11111111-1111-4111-8111-111111111111")).toMatchObject({
      state: "working",
      messages: [
        { role: "person", text: "Summarise it" },
        { role: "agent", text: "It runs " },
      ],
    });
  });

  it("holds back the word a running Work reply has not finished", () => {
    const readLive = (text: string) =>
      visitorThreadSource(
        unusedConnection,
        () => ({}),
        workThreads({
          turns: () => [
            {
              requestId: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
              turnId: "turn-1",
              status: "running",
              transcript: [{ role: "user", text: "Show the secret" }],
            },
          ],
          liveReplyText: () => text,
          activity: () => ({ executing: true, awaitingInput: false }),
        }),
      ).read("work", "11111111-1111-4111-8111-111111111111");

    const partial = readLive("The secret is\nwhsec_abc123");
    expect(partial).toMatchObject({
      messages: [
        { role: "person", text: "Show the secret" },
        { role: "agent", text: "The secret is\n" },
      ],
    });
    expect(JSON.stringify(partial)).not.toContain("whsec_");
    // A reply that is still one unfinished word shows nothing yet.
    expect(readLive("whsec_abc")).toMatchObject({
      messages: [{ role: "person", text: "Show the secret" }],
    });
  });

  it("finds no Work thread that is gone, being deleted, or not a Work thread id", () => {
    const gone = visitorThreadSource(
      unusedConnection,
      () => ({}),
      workThreads({ thread: () => undefined }),
    );
    expect(gone.read("work", "11111111-1111-4111-8111-111111111111")).toEqual({
      status: "missing",
    });
    const deleting = visitorThreadSource(
      unusedConnection,
      () => ({}),
      workThreads({ thread: () => ({ title: "Old", lifecycle: "deleting" }) }),
    );
    expect(deleting.read("work", "11111111-1111-4111-8111-111111111111")).toEqual({
      status: "missing",
    });
    expect(
      visitorThreadSource(unusedConnection, () => ({}), workThreads()).read("work", "not an id"),
    ).toEqual({ status: "missing" });
    expect(
      visitorThreadSource(unusedConnection, () => ({})).read(
        "work",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).toEqual({ status: "missing" });
  });
});
