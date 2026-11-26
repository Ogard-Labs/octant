// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MobileInboxRow, MobileRemoteTransport } from "@octant/client-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../design-system/theme";
import { ThreadScreen } from "./ThreadScreen";

// Everything between the screen's session and the cached file is real: the
// host's health, the clip list, the byte ranges and the playback copy.
const { context, cachedFiles, nothing } = vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __DEV__: true });
  return {
    context: { current: undefined as unknown },
    cachedFiles: new Map<string, number>(),
    nothing: () => null,
  };
});
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  Directory: class {},
  File: class {
    readonly uri: string;
    constructor(directory: string, name: string) {
      this.uri = `${directory}/${name}`;
    }
    get exists() {
      return cachedFiles.has(this.uri);
    }
    create() {
      cachedFiles.set(this.uri, 0);
    }
    open() {
      return {
        writeBytes: (bytes: Uint8Array) =>
          cachedFiles.set(this.uri, (cachedFiles.get(this.uri) ?? 0) + bytes.length),
        close: () => undefined,
      };
    }
    delete() {
      cachedFiles.delete(this.uri);
    }
  },
}));
vi.mock("react-native", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("react-native-web")),
  Platform: { OS: "ios", select: (choices: Record<string, unknown>) => choices.ios },
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("expo", () => ({
  useEvent: () => ({ status: "readyToPlay" }),
  requireOptionalNativeModule: () => null,
}));
vi.mock("expo-video", () => ({
  useVideoPlayer: (uri: string) => ({ status: "readyToPlay", uri }),
  VideoView: ({ player }: { readonly player: { readonly uri: string } }) =>
    createElement("div", { "data-testid": "video-playing", "data-uri": player.uri }),
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
}));
vi.mock("../session/MobileSessionContext", () => ({ useMobileSession: () => context.current }));
vi.mock("../session/usePlacementHostModels", () => ({
  usePlacementHostModels: () => ({ options: [], providerDirectory: [] }),
}));
vi.mock("./useRemoteSessionStanding", () => ({
  useRemoteSessionStanding: () => ({ actsAsHostPerson: true, accessLevel: "full" }),
}));
vi.mock("../voice/useVoiceDictation", () => ({ useVoiceDictation: () => undefined }));
vi.mock("../approvals/ApprovalDeferralSheet", () => ({ ApprovalDeferralSheet: nothing }));
vi.mock("../surfaces/AgentProposalCards", () => ({
  MemoryProposalCard: nothing,
  RoutineProposalCard: nothing,
}));
vi.mock("../surfaces/BrowserSurfacePanel", () => ({ BrowserSurfacePanel: nothing }));
vi.mock("../surfaces/NativeHarnessSessionPanel", () => ({ NativeHarnessSessionPanel: nothing }));
vi.mock("../surfaces/BrowserApprovalCard", () => ({ BrowserApprovalCard: nothing }));
vi.mock("../surfaces/ExtensionToolApprovalCard", () => ({ ExtensionToolApprovalCard: nothing }));
vi.mock("../surfaces/ThreadSecretCard", () => ({ ThreadSecretCards: nothing }));
vi.mock("../surfaces/ServiceOfferCard", () => ({ ServiceOfferCard: nothing }));
vi.mock("../surfaces/WorkRequestCards", () => ({ WorkRequestCards: nothing }));
vi.mock("../review/PullRequestReviewPanel", () => ({ PullRequestReviewPanel: nothing }));
vi.mock("../review/CoordinatorProposalsPanel", () => ({ CoordinatorProposalsPanel: nothing }));
vi.mock("../review/ThreadRoutinesPanel", () => ({ ThreadRoutinesPanel: nothing }));
vi.mock("../ui/AttachSourceSheet", () => ({ AttachSourceSheet: nothing }));
vi.mock("../ui/FloatingComposer", () => ({ FloatingComposer: nothing }));
vi.mock("../ui/IconButton", () => ({ IconButton: nothing }));
vi.mock("../ui/NativeChrome", () => ({ NavBar: nothing }));
vi.mock("../ui/ModelPickerSheet", () => ({ ModelPickerSheet: nothing }));
vi.mock("../ui/RewindSheet", () => ({ RewindSheet: nothing }));
vi.mock("../panes/ThreadPanesSheet", () => ({ ThreadPanesSheet: nothing }));
vi.mock("../surfaces/CanvasHtmlImportSheet", () => ({ CanvasHtmlImportSheet: nothing }));
vi.mock("../surfaces/ProjectToolSheets", () => ({
  ProjectPageSheet: nothing,
  ProjectTerminalSheet: nothing,
}));
vi.mock("./thread/DefaultLevelsPanel", () => ({ DefaultLevelsPanel: nothing }));
vi.mock("./thread/ThreadLevelPanel", () => ({ ThreadLevelPanel: nothing }));
vi.mock("./thread/ThreadTranscript", () => ({ ThreadTranscript: nothing }));
vi.mock("./thread/pickAttachment", () => ({ pickAttachment: async () => undefined }));

const hostId = "11111111-1111-4111-8111-111111111111";
const threadId = "e4000000-0000-4000-8000-000000000002";
const jobId = "e4000000-0000-4000-8000-000000000003";
const clipBytes = new Uint8Array(100).fill(7);
const options = { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true };
const row: MobileInboxRow = {
  hostId,
  mode: "work",
  threadId,
  title: "A paper boat",
  status: "active",
  freshness: "2026-11-25T10:00:00.000Z",
} as MobileInboxRow;
const jobs = [
  {
    id: jobId,
    status: "completed",
    threadKind: "work-thread",
    scopeId: threadId,
    profileInstanceId: "e4000000-0000-4000-8000-000000000001",
    driverKind: "gemini-video",
    modelId: "gemini-omni-1.2-flash",
    promptHash: "a".repeat(64),
    options,
    imageCount: 0,
    estimatedCostUsdMicros: 695_040,
    clip: {
      clipId: "e4000000-0000-4000-8000-000000000004",
      hash: "b".repeat(64),
      size: clipBytes.length,
      durationSeconds: options.durationSeconds,
      resolution: options.resolution,
      aspectRatio: options.aspectRatio,
    },
    providerCopy: "removed",
    version: 2,
    createdAt: "2026-11-25T10:00:00.000Z",
    updatedAt: "2026-11-25T10:00:00.000Z",
  },
];

/** One connection to the host, answering only what a clip needs. */
function connection() {
  const asked: Array<string> = [];
  const state = { listStatus: 200 };
  const transport: MobileRemoteTransport = {
    hostId,
    authenticatedFetch: async ({ method, path, headers }) => {
      if (!path.startsWith("/api/video/")) return new Response(null, { status: 503 });
      asked.push(`${method} ${path}`);
      if (path === "/api/video/jobs") {
        return state.listStatus === 200
          ? Response.json({ jobs })
          : new Response(null, { status: state.listStatus });
      }
      if (method === "POST") {
        return Response.json({
          url: `/api/video/clip?ticket=${"t".repeat(43)}`,
          expiresAt: "2026-11-25T10:10:00.000Z",
        });
      }
      expect(headers).toEqual({ range: `bytes=0-${clipBytes.length - 1}` });
      return new Response(clipBytes, {
        status: 206,
        headers: {
          "content-range": `bytes 0-${clipBytes.length - 1}/${clipBytes.length}`,
        },
      });
    },
  };
  return { asked, state, transport };
}

function session(
  health: "ready" | "unavailable" | "unauthorized",
  transport: MobileRemoteTransport | undefined,
  credentialGeneration = 1,
) {
  return {
    environment: { kind: "live" },
    hosts: [{ hostId, label: "Studio", origin: "https://mac.example.test", credentialGeneration }],
    health: [{ hostId, kind: health }],
    hub: { supervisorForOrigin: () => undefined },
    fullAccessWarnings: {},
    transportForHost: () => transport,
  };
}

async function openScreen() {
  const node = document.createElement("div");
  const root = createRoot(node);
  const show = async (current: unknown) => {
    context.current = current;
    await act(async () =>
      root.render(
        createElement(ThemeProvider, {
          preference: "light",
          children: createElement(ThreadScreen, {
            selected: row,
            onBack: () => undefined,
            onOpenThread: () => undefined,
          }),
        }),
      ),
    );
  };
  const poll = () => act(async () => vi.advanceTimersByTimeAsync(5_000));
  const player = () => node.querySelector('[data-testid="video-playing"]');
  const first = connection();
  await show(session("ready", first.transport));
  await poll();
  await act(async () => node.querySelector<HTMLElement>('[aria-label="Open video"]')?.click());
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(player()).not.toBeNull();
  expect([...cachedFiles.values()]).toEqual([clipBytes.length]);
  expect(player()?.getAttribute("data-uri")).toBe([...cachedFiles.keys()][0]);
  return { first, node, player, poll, root, show };
}

beforeEach(() => {
  vi.useFakeTimers();
  cachedFiles.clear();
});
afterEach(() => vi.useRealTimers());

it("keeps the opened clip playing through a lost connection and reads the list again on the new one", async () => {
  const { first, player, poll, root, show } = await openScreen();
  try {
    const playing = player();
    await show(session("unavailable", undefined));
    await poll();
    expect(player()).toBe(playing);
    expect(cachedFiles.size).toBe(1);

    const second = connection();
    await show(session("ready", second.transport));
    const beforeReconnect = first.asked.length;
    await poll();
    expect(second.asked).toEqual(["GET /api/video/jobs"]);
    expect(first.asked).toHaveLength(beforeReconnect);
    expect(player()).toBe(playing);
    expect(cachedFiles.size).toBe(1);
  } finally {
    act(() => root.unmount());
  }
  expect(cachedFiles.size).toBe(0);
});

it("closes the clip and deletes its copy when the phone loses access to the host", async () => {
  const { first, node, player, root, show } = await openScreen();
  try {
    await show(session("unauthorized", first.transport));
    expect(player()).toBeNull();
    expect(node.querySelector('[aria-label="Open video"]')).toBeNull();
    expect(cachedFiles.size).toBe(0);
  } finally {
    act(() => root.unmount());
  }
});

it.each([403, 404])(
  "closes the clip and deletes its copy when the host refuses the thread with %i",
  async (status) => {
    const { first, node, player, poll, root } = await openScreen();
    try {
      first.state.listStatus = status;
      await poll();
      expect(player()).toBeNull();
      expect(node.querySelector('[aria-label="Open video"]')).toBeNull();
      expect(cachedFiles.size).toBe(0);
    } finally {
      act(() => root.unmount());
    }
  },
);

it("drops the copy read under the old pairing once the phone is paired again", async () => {
  const { player, root, show } = await openScreen();
  try {
    await show(session("ready", connection().transport, 2));
    expect(player()).toBeNull();
    expect(cachedFiles.size).toBe(0);
  } finally {
    act(() => root.unmount());
  }
});
