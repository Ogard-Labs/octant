import { randomBytes } from "node:crypto";
import {
  decodeNightlyWindowBootstrap,
  type NightlyWindowBootstrap,
} from "@octant/contracts/nightly-browser";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { installNightlyBrokeredFlows } from "./nightlyBrokeredFlows";
import { NEEDS_NEWER_OCTANT } from "./nightlyClientChannels";
import { createNativeMainAuthority } from "./nightlyNativeMainAuthority";

const token = () => randomBytes(32).toString("base64url");
const windowId = "10000000-0000-4000-8000-0000000006a1";
const receiptId = "r".repeat(43);

function bootstrap(extra: Record<string, unknown>): NightlyWindowBootstrap {
  return decodeNightlyWindowBootstrap({
    kind: "registered",
    protocol: 1,
    windowId,
    generation: 1,
    hostOrigin: "http://127.0.0.1:13773",
    hostInstance: "00000000-0000-4000-8000-000000000594",
    capability: token(),
    rendererIdentity: token(),
    leaseMs: 15_000,
    ...extra,
  });
}

function harness(window: NightlyWindowBootstrap) {
  const handlers = new Map<string, (event: unknown, ...values: unknown[]) => unknown>();
  const nativeMain = createNativeMainAuthority();
  nativeMain.remember(7, window);
  const owned = { isDestroyed: () => false };
  const fetch = vi.fn(async () =>
    Response.json({ receiptId, projectType: "work", expiresAt: 2_000 }, { status: 201 }),
  );
  const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ["/picked/root"] }));
  const spawn = vi.fn();
  installNightlyBrokeredFlows({
    register: (channel, handler) => handlers.set(channel, handler as never),
    owns: (event) => {
      if ((event as { sender: { id: number } }).sender.id !== 7) throw new Error("not owned");
      return owned;
    },
    bootstrap: (id) => (id === 7 ? window : undefined),
    nativeMain,
    dialog: { showOpenDialog, showSaveDialog: vi.fn() },
    downloadsDirectory: () => "/Downloads",
    fetch: fetch as unknown as typeof globalThis.fetch,
    shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
    spawn,
    spawnQuickLook: vi.fn(),
    exists: () => true,
    homeDirectory: "/Users/person",
    platform: "darwin",
  });
  const event = { sender: { id: 7 } };
  const invoke = (channel: string, ...values: unknown[]) => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return handler(event, ...values);
  };
  return { handlers, fetch, showOpenDialog, spawn, invoke };
}

describe("Nightly brokered pickers and handoffs", () => {
  it("answers every picker and handoff channel", () => {
    const { handlers } = harness(bootstrap({}));
    expect([...handlers.keys()].sort()).toEqual(
      [
        DESKTOP_IPC_CHANNELS.selectProjectRoot,
        DESKTOP_IPC_CHANNELS.selectLocalPluginFolder,
        DESKTOP_IPC_CHANNELS.selectSkillFolder,
        DESKTOP_IPC_CHANNELS.selectRuntimeBinary,
        DESKTOP_IPC_CHANNELS.saveSupportBundle,
        DESKTOP_IPC_CHANNELS.openCodeExternalEditor,
        DESKTOP_IPC_CHANNELS.openCodeCheckoutInApplication,
        DESKTOP_IPC_CHANNELS.previewHandoff,
      ].sort(),
    );
  });

  it("asks the window's host for a Project root receipt with its own main-only authority", async () => {
    const nativeMainToken = token();
    const window = bootstrap({ nativeMainToken, hostFeatures: ["project-root-receipts"] });
    const { fetch, invoke } = harness(window);
    await expect(invoke(DESKTOP_IPC_CHANNELS.selectProjectRoot, "work")).resolves.toEqual({
      kind: "selected",
      receiptId,
      displayName: "root",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:13773/api/desktop/project-binding-receipts");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-octant-window-capability": window.capability,
      "x-octant-native-main-authority": nativeMainToken,
    });
    expect(JSON.parse(String(init.body))).toEqual({
      windowId,
      projectType: "work",
      path: "/picked/root",
    });
  });

  it("says it needs a newer Octant, before any dialog, when the host does not broker the flow", async () => {
    const { fetch, showOpenDialog, invoke } = harness(
      bootstrap({ nativeMainToken: token(), hostFeatures: ["preview-handoff"] }),
    );
    for (const channel of [
      DESKTOP_IPC_CHANNELS.selectProjectRoot,
      DESKTOP_IPC_CHANNELS.selectLocalPluginFolder,
      DESKTOP_IPC_CHANNELS.selectSkillFolder,
      DESKTOP_IPC_CHANNELS.selectRuntimeBinary,
      DESKTOP_IPC_CHANNELS.saveSupportBundle,
      DESKTOP_IPC_CHANNELS.openCodeExternalEditor,
      DESKTOP_IPC_CHANNELS.openCodeCheckoutInApplication,
    ])
      await expect(invoke(channel, "work")).rejects.toThrow(NEEDS_NEWER_OCTANT);
    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("brokers nothing for a window an older Octant opened without a main-only token", async () => {
    const { fetch, invoke } = harness(bootstrap({}));
    await expect(invoke(DESKTOP_IPC_CHANNELS.previewHandoff, {})).rejects.toThrow(
      NEEDS_NEWER_OCTANT,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a sender that is not one of Nightly's windows", async () => {
    const { handlers } = harness(
      bootstrap({ nativeMainToken: token(), hostFeatures: ["project-root-receipts"] }),
    );
    const handler = handlers.get(DESKTOP_IPC_CHANNELS.selectProjectRoot);
    await expect(async () => handler?.({ sender: { id: 8 } }, "work")).rejects.toThrow("not owned");
  });
});
