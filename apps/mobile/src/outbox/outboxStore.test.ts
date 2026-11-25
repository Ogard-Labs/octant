import type { MobileRemoteTransport, MobileSendResult } from "@octant/client-runtime";
import { describe, expect, it } from "vitest";
import type { Pairing, WaitingMessage } from "./outbox";
import { OutboxStore, type OutboxPorts } from "./outboxStore";

const pairing: Pairing = { hostKeyFingerprint: "studio-key", keyId: "phone-1" };
const transport: MobileRemoteTransport = {
  hostId: "studio",
  authenticatedFetch: async () => Response.json({}),
};
const target = { hostId: "studio", pairing, transport };
const message = (id: string, fields: Partial<WaitingMessage> = {}): WaitingMessage => ({
  id,
  hostId: "studio",
  mode: "code",
  threadId: `thread-${id}`,
  text: `Message ${id}`,
  pairing,
  writtenAt: new Date().toISOString(),
  ...fields,
});
const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function phone(kept: string | null = null) {
  const held = { kept };
  const sent: string[] = [];
  const waiting: Array<(result: MobileSendResult) => void> = [];
  const ports: OutboxPorts = {
    load: async () => held.kept,
    keep: async (text) => {
      held.kept = text ?? null;
    },
    send: ({ message: entry, stillWanted }) => {
      if (!stillWanted()) return Promise.resolve({ status: "withdrawn" });
      sent.push(entry.id);
      return new Promise((resolve) => waiting.push(resolve));
    },
    reasons: { tooOld: "old", otherComputer: "other", pairedAgain: "again" },
    now: () => new Date(),
  };
  const ids = () =>
    (JSON.parse(held.kept ?? '{"messages":[]}') as { messages: WaitingMessage[] }).messages.map(
      (entry) => entry.id,
    );
  return { held, ids, ports, sent, waiting };
}
const queued = { status: "queued", snapshot: {} } as unknown as MobileSendResult;

describe("the messages that wait", () => {
  it("keeps what the person did while a send from before a lock was under way", async () => {
    const at = phone();
    const store = new OutboxStore(at.ports);
    const close = store.attach();
    await settle();
    store.keep(message("A"));
    store.keep(message("B"));
    store.setTargets([target], () => undefined);
    await settle();
    expect(at.sent).toEqual(["A"]);
    // The app is locked and opened again; B is deleted and C written.
    close();
    store.attach();
    store.remove("B");
    store.keep(message("C"));
    await settle();
    at.waiting[0]?.({ status: "unreachable" });
    await settle();
    expect(at.ids()).toEqual(["A", "C"]);
    expect(at.sent).toEqual(["A"]);
  });

  it("starts nothing while the app is closed, and takes what the computer said meanwhile", async () => {
    const at = phone();
    const store = new OutboxStore(at.ports);
    const close = store.attach();
    await settle();
    store.keep(message("A"));
    store.keep(message("B"));
    store.setTargets([target], () => undefined);
    await settle();
    close();
    at.waiting[0]?.(queued);
    await settle();
    expect(at.sent).toEqual(["A"]);
    expect(at.ids()).toEqual(["B"]);
  });

  it("does not send a message deleted as it was about to leave", async () => {
    const at = phone();
    let release: (() => void) | undefined;
    const store = new OutboxStore({
      ...at.ports,
      keep: async (text) => {
        if (text?.includes('"attempted":true') === true)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        await at.ports.keep(text);
      },
    });
    store.attach();
    await settle();
    store.keep(message("A"));
    store.setTargets([target], () => undefined);
    await settle();
    store.remove("A");
    release?.();
    await settle();
    expect(at.sent).toEqual([]);
  });

  it("sends nothing it could not first keep as sent", async () => {
    const at = phone();
    const store = new OutboxStore({
      ...at.ports,
      keep: async () => {
        throw new Error("The disk is full.");
      },
    });
    store.attach();
    await settle();
    store.keep(message("A"));
    store.setTargets([target], () => undefined);
    await settle();
    expect(at.sent).toEqual([]);
    expect(store.read().unsaved).toBe(true);
  });

  it("writes nothing over what it could not read", async () => {
    const at = phone("kept");
    const store = new OutboxStore({
      ...at.ports,
      load: async () => {
        throw new Error("The keychain did not answer.");
      },
    });
    const close = store.attach();
    store.keep(message("A"));
    await settle();
    expect(at.held.kept).toBe("kept");
    expect(store.read().outbox.messages.map((entry) => entry.id)).toEqual(["A"]);
    close();
  });

  it("holds a message when another computer answers under its computer's id", async () => {
    const at = phone();
    const store = new OutboxStore(at.ports);
    store.attach();
    await settle();
    store.keep(message("A"));
    store.setTargets(
      [{ ...target, pairing: { ...pairing, hostKeyFingerprint: "evil" } }],
      () => undefined,
    );
    await settle();
    expect(at.sent).toEqual([]);
    expect(store.read().outbox.messages[0]?.refused).toBe("other");
  });

  it("remembers what a computer last said of the phone through a lock", () => {
    const store = new OutboxStore(phone().ports);
    store.attach()();
    store.noteStanding("studio", { actsAsHostPerson: true });
    store.attach();
    expect(store.lastStanding("studio")).toEqual({ actsAsHostPerson: true });
  });
});
