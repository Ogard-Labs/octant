// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutboxProvider, useOutbox, type OutboxApi } from "./OutboxContext";
import type { WaitingMessage } from "./outbox";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "60000000-0000-4000-8000-000000000001";
const id = "60000000-0000-4000-8000-000000000005";
const held = vi.hoisted(() => ({
  session: undefined as unknown,
  kept: null as string | null,
}));
vi.mock("../session/MobileSessionContext", () => ({ useMobileSession: () => held.session }));
vi.mock("../inbox/MobileThreadsContext", () => ({
  useMobileThreads: () => ({ refresh: async () => undefined }),
}));
vi.mock("./sealedText", () => ({
  createSealedText: () => ({
    load: async () => held.kept,
    keep: async (text: string | undefined) => {
      held.kept = text ?? null;
    },
  }),
}));

type Answer = (body: Record<string, unknown>) => unknown;
let sent: Array<Record<string, unknown>>;
let answer: Answer;
let outbox: OutboxApi;
let root: Root;

const snapshot = { scope: { mode: "code", threadId }, version: 1, paused: false, items: [] };
const transport = {
  hostId: "studio",
  authenticatedFetch: async ({ path, body }: { path: string; body?: string }) => {
    if (path !== "/api/thread-message-queue/commands")
      return Response.json({ status: "ready", snapshot });
    const command = JSON.parse(String(body)) as Record<string, unknown>;
    sent.push(command);
    return Response.json(answer(command));
  },
};
const applied: Answer = (command) => ({
  status: "applied",
  requestId: command.requestId,
  snapshot: { ...snapshot, version: 2 },
});
const message = (fields: Partial<WaitingMessage> = {}): WaitingMessage => ({
  id,
  hostId: "studio",
  mode: "code",
  threadId,
  text: "And the docs",
  writtenAt: new Date().toISOString(),
  ...fields,
});

function Reader() {
  outbox = useOutbox();
  return null;
}
async function render(health: string, fields: object = {}): Promise<void> {
  held.session = {
    environment: { kind: "live" },
    hosts: [{ hostId: "studio" }],
    hostsLoaded: true,
    hostsError: undefined,
    health: [{ hostId: "studio", kind: health }],
    transports: [transport],
    ...fields,
  };
  await act(async () =>
    root.render(createElement(OutboxProvider, { children: createElement(Reader) })),
  );
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 20)));
}
const waiting = () => outbox.waitingFor(message()).map((entry) => entry.id);

beforeEach(() => {
  sent = [];
  answer = applied;
  held.kept = null;
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

describe("a message written while its computer is out of reach", () => {
  it("waits, and is sent once when the computer is ready", async () => {
    await render("unavailable");
    act(() => void outbox.keep(message()));
    await render("unavailable");
    expect(sent).toEqual([]);
    expect(waiting()).toEqual([id]);
    expect(held.kept).toContain("And the docs");
    await render("ready");
    await render("ready");
    expect(sent.map((command) => command.messageId)).toEqual([id]);
    expect(waiting()).toEqual([]);
    expect(held.kept).toBeNull();
  });

  it("is sent after the app was closed and opened again", async () => {
    held.kept = JSON.stringify({ messages: [message()] });
    await render("ready");
    expect(sent.map((command) => command.messageId)).toEqual([id]);
  });

  it("comes back with the reason when the computer refuses it", async () => {
    answer = (command) => ({
      status: "refused",
      requestId: command.requestId,
      reason: "queue-full",
    });
    await render("unavailable");
    act(() => void outbox.keep(message()));
    await render("ready");
    expect(outbox.waitingFor(message())[0]?.refused).toBe("The queue is full.");
    await render("ready");
    expect(sent).toHaveLength(1);
  });

  it("is not sent by a session the computer rejected, nor by the demo", async () => {
    held.kept = JSON.stringify({ messages: [message()] });
    for (const [health, fields] of [
      ["unauthorized", {}],
      ["incompatible", {}],
      ["stale", {}],
      ["ready", { environment: { kind: "mock" } }],
    ] as const)
      await render(health, fields);
    expect(sent).toEqual([]);
  });

  it("is dropped with its computer, but not when the computers could not be read", async () => {
    held.kept = JSON.stringify({ messages: [message()] });
    await render("unavailable", { hosts: [], hostsError: "locked" });
    expect(held.kept).toContain(id);
    await render("unavailable", { hosts: [], hostsError: undefined });
    expect(held.kept).toBeNull();
  });
});
