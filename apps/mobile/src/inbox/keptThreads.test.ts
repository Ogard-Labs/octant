import type { MobileInboxRow } from "@octant/client-runtime";
import { describe, expect, it } from "vitest";
import { KEPT_ROWS, keptThreadsText, restoreKeptThreads } from "./keptThreads";

const studio = { hostId: "studio", hostKeyFingerprint: "key-1", keyId: "phone-1" };
const laptop = { hostId: "laptop", hostKeyFingerprint: "key-2", keyId: "phone-1" };
const none = new Map();

function row(threadId: string, hostId = "studio", extra: Partial<MobileInboxRow> = {}) {
  return {
    hostId,
    mode: "work",
    threadId,
    title: `Thread ${threadId}`,
    status: "idle",
    freshness: "2026-11-25T10:00:00.000Z",
    projectId: "travel",
    ...extra,
  } satisfies MobileInboxRow;
}

describe("the thread list kept on the phone", () => {
  it("comes back with its Project names for the computers it was read from", () => {
    const text = keptThreadsText(
      {
        rows: [row("a"), row("b", "laptop")],
        projects: [
          { hostId: "studio", projectId: "travel", name: "Travel" },
          { hostId: "laptop", projectId: "home", name: "Home" },
        ],
        standings: new Map([["studio", { actsAsHostPerson: true, accessLevel: "full" as const }]]),
      },
      [studio, laptop],
    );
    const kept = restoreKeptThreads(text ?? null, [studio, laptop]);
    expect(kept.rows.map((entry) => `${entry.hostId}/${entry.threadId}`).sort()).toEqual([
      "laptop/b",
      "studio/a",
    ]);
    expect(kept.rows.find((entry) => entry.threadId === "a")?.title).toBe("Thread a");
    expect(kept.projects).toContainEqual({ hostId: "studio", projectId: "travel", name: "Travel" });
    expect(kept.standings.get("studio")).toEqual({ actsAsHostPerson: true, accessLevel: "full" });
    expect(kept.standings.has("laptop")).toBe(false);
  });

  it("does not claim a turn still runs, an ask still waits, or a thread is unread", () => {
    const text = keptThreadsText(
      {
        rows: [
          row("a", "studio", {
            unread: true,
            live: "working",
            waitingAsk: { label: "Approve a command" },
          }),
        ],
        projects: [],
        standings: none,
      },
      [studio],
    );
    const [kept] = restoreKeptThreads(text ?? null, [studio]).rows;
    expect(kept).toBeDefined();
    expect(kept?.unread).toBeUndefined();
    expect(kept?.live).toBeUndefined();
    expect(kept?.waitingAsk).toBeUndefined();
  });

  it("gives nothing back to a computer paired again under another key, or no longer paired", () => {
    const text = keptThreadsText(
      { rows: [row("a"), row("b", "laptop")], projects: [], standings: none },
      [studio, laptop],
    );
    expect(
      restoreKeptThreads(text ?? null, [{ ...studio, hostKeyFingerprint: "new" }]).rows,
    ).toEqual([]);
    expect(restoreKeptThreads(text ?? null, [{ ...studio, keyId: "phone-2" }]).rows).toEqual([]);
    expect(restoreKeptThreads(text ?? null, [laptop]).rows.map((entry) => entry.hostId)).toEqual([
      "laptop",
    ]);
  });

  it("keeps nothing for a computer the phone is not paired with", () => {
    expect(
      keptThreadsText({ rows: [row("a")], projects: [], standings: none }, [laptop]),
    ).toBeUndefined();
  });

  it("keeps the newest threads when there are more than it holds", () => {
    const rows = Array.from({ length: KEPT_ROWS + 20 }, (_, index) =>
      row(`t${index}`, "studio", {
        freshness: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      }),
    );
    const kept = restoreKeptThreads(
      keptThreadsText({ rows, projects: [], standings: none }, [studio]) ?? null,
      [studio],
    );
    expect(kept.rows).toHaveLength(KEPT_ROWS);
    expect(kept.rows.some((entry) => entry.threadId === `t${KEPT_ROWS + 19}`)).toBe(true);
    expect(kept.rows.some((entry) => entry.threadId === "t0")).toBe(false);
  });

  it("keeps each computer's newest threads, however many another computer has", () => {
    const rows = [
      ...Array.from({ length: KEPT_ROWS }, (_, index) =>
        row(`s${index}`, "studio", { freshness: "2026-11-26T10:00:00.000Z" }),
      ),
      row("older", "laptop", { freshness: "2026-11-01T10:00:00.000Z" }),
    ];
    const kept = restoreKeptThreads(
      keptThreadsText({ rows, projects: [], standings: none }, [studio, laptop]) ?? null,
      [studio, laptop],
    );
    expect(kept.rows.filter((entry) => entry.hostId === "studio")).toHaveLength(KEPT_ROWS);
    expect(kept.rows.some((entry) => entry.threadId === "older")).toBe(true);
  });

  it("reads text it cannot make sense of as no list, and skips rows that are not threads", () => {
    expect(restoreKeptThreads("not json", [studio]).rows).toEqual([]);
    expect(restoreKeptThreads(JSON.stringify({ version: 9, hosts: {} }), [studio]).rows).toEqual(
      [],
    );
    const odd = JSON.stringify({
      version: 1,
      hosts: {
        studio: {
          fingerprint: "key-1",
          keyId: "phone-1",
          standing: { actsAsHostPerson: true, accessLevel: "everything" },
          rows: [row("a"), { ...row("b"), mode: "other" }, row("c", "laptop"), null],
          projects: [{ projectId: 3 }],
        },
      },
    });
    const kept = restoreKeptThreads(odd, [studio]);
    expect(kept.rows.map((entry) => entry.threadId)).toEqual(["a"]);
    expect(kept.projects).toEqual([]);
    expect(kept.standings.size).toBe(0);
  });
});
