// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSelectedThreadGuard } from "./selectedThreadGuard";
import { useTurnControl, type TurnControl } from "./useTurnControl";

vi.mock("../../ui/haptics", () => ({ hapticFailure: () => {}, hapticSuccess: () => {} }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "60000000-0000-4000-8000-000000000001";
const scope = { mode: "code", threadId };
const snapshot = { scope, version: 1, paused: false, items: [] };

let root: Root;
let control: TurnControl;
let prompts: string[];
let errors: Array<string | undefined>;
let keeps: boolean;
let unanswered: Array<{ readonly id: string; readonly text: string }>;

function Harness(props: { readonly transport: MobileRemoteTransport }) {
  control = useTurnControl({
    transport: props.transport,
    target: { identity: "host:thread", hostId: "host", threadId, mode: "code" },
    guard,
    ui,
    gate: { allowProductMutations: true, message: "" },
    prompt: "And the docs",
    setPrompt: (next) => prompts.push(next),
    live: true,
    stopTurn: undefined,
    attachmentIds: [],
    onQueued: () => {},
    onUnanswered: (message) => {
      unanswered.push(message);
      return keeps;
    },
    onStopped: () => {},
  });
  return null;
}
const guard = createSelectedThreadGuard();
const ui = { setBusy: () => {}, setError: (message: string | undefined) => errors.push(message) };

async function render(transport: MobileRemoteTransport): Promise<void> {
  guard.select("host:thread");
  await act(async () => root.render(createElement(Harness, { transport })));
}

beforeEach(() => {
  vi.useFakeTimers();
  prompts = [];
  errors = [];
  unanswered = [];
  keeps = true;
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("queueing behind a running turn", () => {
  it("queues the words once however often Send is pressed", async () => {
    const queued: string[] = [];
    const transport: MobileRemoteTransport = {
      hostId: "host",
      authenticatedFetch: async ({ path, body }) => {
        if (path !== "/api/thread-message-queue/commands")
          return Response.json({ status: "ready", snapshot });
        const command = JSON.parse(String(body)) as { requestId: string };
        queued.push(command.requestId);
        return Response.json({
          status: "applied",
          requestId: command.requestId,
          snapshot: { ...snapshot, version: 2 },
        });
      },
    };
    await render(transport);
    await act(async () => {
      await Promise.all([control.queueMessage(), control.queueMessage()]);
    });
    expect(queued).toHaveLength(1);
    expect(prompts).toEqual([""]);
    expect(control.pending).toBe(false);
  });

  it("keeps the queue it read when a later read is lost", async () => {
    let lost = false;
    await render({
      hostId: "host",
      authenticatedFetch: async () => {
        if (lost) throw new TypeError("Network request failed");
        return Response.json({ status: "ready", snapshot });
      },
    });
    expect(control.queue?.version).toBe(1);
    lost = true;
    await act(async () => vi.advanceTimersByTimeAsync(9_000));
    expect(control.queue?.version).toBe(1);
  });

  it("hands a message that got no answer on under its id, and does not offer it for a second send", async () => {
    const sent: string[] = [];
    await render({
      hostId: "host",
      authenticatedFetch: async ({ path, body }) => {
        if (path !== "/api/thread-message-queue/commands")
          return Response.json({ status: "ready", snapshot });
        sent.push((JSON.parse(String(body)) as { messageId: string }).messageId);
        throw new TypeError("Network request failed");
      },
    });
    await act(async () => control.queueMessage());
    expect(new Set(sent)).toEqual(new Set([unanswered[0]?.id]));
    expect(unanswered).toEqual([{ id: sent[0], text: "And the docs" }]);
    expect(prompts).toEqual([""]);
  });

  it("keeps the draft when the phone cannot hold the message, and sends it again as the same one", async () => {
    keeps = false;
    const sent: string[] = [];
    await render({
      hostId: "host",
      authenticatedFetch: async ({ path, body }) => {
        if (path !== "/api/thread-message-queue/commands")
          return Response.json({ status: "ready", snapshot });
        sent.push((JSON.parse(String(body)) as { messageId: string }).messageId);
        throw new TypeError("Network request failed");
      },
    });
    await act(async () => control.queueMessage());
    expect(prompts).toEqual([]);
    await act(async () => control.queueMessage());
    expect(new Set(sent).size).toBe(1);
  });

  it("offers no queue where the computer refuses one", async () => {
    await render({
      hostId: "host",
      authenticatedFetch: async () => new Response("no", { status: 403 }),
    });
    expect(control.queue).toBeUndefined();
    await act(async () => control.queueMessage());
    expect(prompts).toEqual([]);
  });

  it("keeps the draft and says why when the computer takes no message", async () => {
    await render({
      hostId: "host",
      authenticatedFetch: async ({ path, body }) =>
        path === "/api/thread-message-queue/commands"
          ? Response.json({
              status: "refused",
              requestId: (JSON.parse(String(body)) as { requestId: string }).requestId,
              reason: "queue-full",
            })
          : Response.json({ status: "ready", snapshot }),
    });
    await act(async () => control.queueMessage());
    expect(prompts).toEqual([]);
    expect(errors.at(-1)).toBe("The queue is full.");
  });
});
