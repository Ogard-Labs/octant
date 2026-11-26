// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { expect, it, vi } from "vitest";
import { createSelectedThreadGuard } from "./selectedThreadGuard";
import { useCodeThread } from "./useCodeThread";

const asked = vi.hoisted(() => ({
  reads: [] as Array<{ readonly anchor: string | undefined; readonly focus: string | undefined }>,
}));
vi.mock("@octant/client-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@octant/client-runtime")>()),
  loadMobileCodeThread: async () => ({
    executionPolicy: undefined,
    providerInstanceId: "p",
    modelId: "m",
  }),
}));
vi.mock("./codeConversationPage", () => ({
  loadCodeConversationPage: async (
    _transport: unknown,
    _threadId: string,
    anchor: string | undefined,
    focus: string | undefined,
  ) => {
    asked.reads.push({ anchor, focus });
    // A hit's page is an older one, anchored on that hit.
    return { loaded: { turns: [] }, anchoredAt: focus };
  },
  looksForTurnStartedElsewhere: () => false,
  refreshesForNewestTurn: () => false,
  rereadsCodeThread: () => false,
}));
vi.mock("./useThreadAttachments", () => ({
  useThreadAttachments: () => ({ pending: [], sent: () => undefined }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const guard = createSelectedThreadGuard();
const transport: MobileRemoteTransport = { hostId: "host", authenticatedFetch: vi.fn() };
let refresh: (() => Promise<void>) | undefined;

function Harness(props: { readonly focus: string | undefined }) {
  const code = useCodeThread(
    {
      transport,
      target: { identity: "host:t1", hostId: "host", threadId: "t1", mode: "code" },
      guard,
      ui: { setBusy: () => undefined, setError: () => undefined },
      gate: { allowProductMutations: true, message: "" },
      prompt: "",
      typedScope: "thread:host:t1",
      setPrompt: () => undefined,
    },
    props.focus,
  );
  refresh = () => code.refresh();
  return null;
}

it("loads a second search hit's page in the thread already open, and the newest once its row is opened", async () => {
  guard.select("host:t1");
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness, { focus: "turn-a" })));
  await act(async () => refresh?.());
  // Read again while on the first hit's older page: it stays there.
  await act(async () => refresh?.());
  await act(async () => root.render(createElement(Harness, { focus: "turn-b" })));
  await act(async () => root.render(createElement(Harness, { focus: undefined })));
  expect(asked.reads).toEqual([
    { anchor: undefined, focus: "turn-a" },
    { anchor: "turn-a", focus: undefined },
    { anchor: undefined, focus: "turn-b" },
    { anchor: undefined, focus: undefined },
  ]);
  act(() => root.unmount());
});
