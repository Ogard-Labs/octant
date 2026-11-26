import { describe, expect, it } from "vitest";
import {
  addWaiting,
  dropHostsNotIn,
  dueMessages,
  EMPTY_OUTBOX,
  markAttempted,
  markRefused,
  parseOutbox,
  removeWaiting,
  tryAgain,
  waitingFor,
  type WaitingMessage,
} from "./outbox";

const now = new Date("2026-11-25T12:00:00.000Z");
const pairing = { hostKeyFingerprint: "studio-key", keyId: "phone-1" };
const studio = { hostId: "studio", pairing };
const message = (id: string, fields: Partial<WaitingMessage> = {}): WaitingMessage => ({
  id,
  hostId: "studio",
  mode: "code",
  threadId: "thread",
  text: `Message ${id}`,
  writtenAt: "2026-11-25T11:00:00.000Z",
  pairing,
  ...fields,
});
const added = (...messages: ReadonlyArray<WaitingMessage>) =>
  messages.reduce((outbox, entry) => addWaiting(outbox, entry).outbox, EMPTY_OUTBOX);
const ids = (messages: ReadonlyArray<WaitingMessage>) => messages.map((entry) => entry.id);

describe("messages waiting for a computer", () => {
  it("sends a thread's messages in the order they were written, one at a time", () => {
    const outbox = added(message("1"), message("2"), message("3", { threadId: "other" }));
    expect(ids(dueMessages(outbox, studio, now).send)).toEqual(["1", "3"]);
    expect(ids(dueMessages(removeWaiting(outbox, "1"), studio, now).send)).toEqual(["2", "3"]);
  });

  it("holds what follows a message the computer refused, until the person decides", () => {
    const outbox = markRefused(added(message("1"), message("2")), "1", "The queue is full.");
    expect(dueMessages(outbox, studio, now).send).toEqual([]);
    expect(waitingFor(outbox, message("x"))[0]?.refused).toBe("The queue is full.");
    expect(ids(dueMessages(removeWaiting(outbox, "1"), studio, now).send)).toEqual(["2"]);
  });

  it("does not send yesterday's words on its own", () => {
    const outbox = added(message("1", { writtenAt: "2026-11-24T11:59:00.000Z" }));
    const due = dueMessages(outbox, studio, now);
    expect(due.send).toEqual([]);
    expect(due.held.map((entry) => `${entry.message.id} ${entry.why}`)).toEqual(["1 tooOld"]);
  });

  it("sends words the person says still apply, under the same id", () => {
    const outbox = markRefused(added(message("1")), "1", "Too old.");
    const again = tryAgain(outbox, "1", now);
    expect(ids(dueMessages(again, studio, now).send)).toEqual(["1"]);
    expect(markAttempted(again, "1").messages[0]?.attempted).toBe(true);
    expect(markAttempted(again, "other")).toBe(again);
  });

  it("sends nothing to a computer it was not written for", () => {
    expect(dueMessages(added(message("1")), { ...studio, hostId: "laptop" }, now).send).toEqual([]);
  });

  it("is never sent to another computer that took its computer's id", () => {
    const other = { hostId: "studio", pairing: { hostKeyFingerprint: "evil", keyId: "phone-1" } };
    const due = dueMessages(added(message("1")), other, now);
    expect(due.send).toEqual([]);
    expect(due.held[0]?.why).toBe("otherComputer");
    const again = tryAgain(added(message("1")), "1", now, other.pairing);
    expect(dueMessages(again, other, now).send).toEqual([]);
  });

  it("waits for the person when its computer was paired again", () => {
    const repaired = { hostId: "studio", pairing: { ...pairing, keyId: "phone-2" } };
    const due = dueMessages(added(message("1")), repaired, now);
    expect(due.held[0]?.why).toBe("pairedAgain");
    const again = tryAgain(added(message("1")), "1", now, repaired.pairing);
    expect(ids(dueMessages(again, repaired, now).send)).toEqual(["1"]);
  });

  it("leaves with its computer", () => {
    const outbox = added(message("1"), message("2", { hostId: "laptop" }));
    expect(ids(dropHostsNotIn(outbox, new Set(["laptop"])).messages)).toEqual(["2"]);
  });

  it("holds one message once, however often it is brought", () => {
    expect(ids(added(message("1"), message("1")).messages)).toEqual(["1"]);
  });

  it("takes no more than it can hold, and says so", () => {
    let outbox = EMPTY_OUTBOX;
    for (let index = 0; index < 50; index += 1)
      outbox = addWaiting(outbox, message(String(index))).outbox;
    expect(addWaiting(outbox, message("over")).status).toBe("full");
    expect(addWaiting(EMPTY_OUTBOX, message("long", { text: "x".repeat(20_001) })).status).toBe(
      "too-long",
    );
    expect(addWaiting(EMPTY_OUTBOX, message("blank", { text: "  " })).status).toBe("empty");
  });

  it("survives a restart, and starts over from what it cannot read", () => {
    const outbox = markRefused(added(message("1"), message("2")), "1", "No.");
    expect(parseOutbox(JSON.stringify(outbox))).toEqual(outbox);
    for (const kept of [null, "no", "{}", '{"messages":[{"id":1}]}'])
      expect(parseOutbox(kept)).toEqual(EMPTY_OUTBOX);
  });
});
