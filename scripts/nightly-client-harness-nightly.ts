// Nightly side of the Nightly client smoke.
//
// `smoke-nightly-client.ts` bundles this file and launches it in the Electron
// the desktop app ships, under Playwright. It runs the real ordinary Nightly
// client, `runNightlyClient`, with the Nightly identity. Only the native window
// binding is stood in for: register, renew and revoke travel over a private
// local socket to the synthetic Stable lease owner
// (`nightly-client-harness-stable.ts`), which answers them with Stable's real
// lease owner against a real development host. Everything after the window's
// bootstrap — renderer, host admission, native-main brokered routes, embedded
// Browser presentation, recovery and quit — is the shipped code.
//
// Process-wide side effects a test must not leave behind are stubbed: the
// URL-scheme registration, modal error boxes, the folder picker (it answers
// the folder the smoke names and reports that it was asked), window focus,
// and the native menu's own event loop (see below).
//
// It quits when its owner exits or after its maximum lifetime. Never
// packaged: packaging refuses any payload that carries the marker below.

import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { app, BrowserWindow, dialog, Menu } from "electron";
import { desktopIdentity } from "@octant/host-runtime";
import { NATIVE_MAIN_AUTHORITY_HEADER } from "@octant/contracts/nightly-browser";
import { runNightlyClient } from "../apps/desktop/src/nightlyClient";

export const NIGHTLY_CLIENT_HARNESS_MARKER = "octant-nightly-client-harness@1";

const MAX_LIFETIME_MS = Number(process.env.OCTANT_HARNESS_MAX_LIFETIME_MS ?? 300_000);
const socketPath = process.env.OCTANT_HARNESS_SOCKET ?? "";
const work = process.env.OCTANT_HARNESS_WORK ?? "";
const pickedFolder = process.env.OCTANT_HARNESS_PICK_FOLDER ?? "";
const ownerPid = Number(process.env.OCTANT_HARNESS_OWNER_PID ?? "0");
const menuPick = process.env.OCTANT_HARNESS_MENU_PICK ?? "";

function emit(event: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`HARNESS ${JSON.stringify({ event, ...detail })}\n`);
}

app.setPath("userData", join(work, "nightly-user-data"));
app.setAsDefaultProtocolClient = () => true;
dialog.showErrorBox = (title, content) => emit("error-box", { title, content });
dialog.showOpenDialog = (async (...values: ReadonlyArray<unknown>) => {
  const options = values.at(-1);
  emit("open-dialog", {
    properties:
      typeof options === "object" && options !== null && "properties" in options
        ? options.properties
        : [],
  });
  return { canceled: false, filePaths: [pickedFolder] };
}) as typeof dialog.showOpenDialog;

// The embedded Browser takes a person's input only in the focused window.
// Focusing a window would take the desktop from whoever is using it, so the
// harness's windows count as focused instead.
BrowserWindow.prototype.isFocused = () => true;

// A native menu runs its own event loop that no test can click. This one
// reports its labels, chooses the item the smoke names (or none), and closes
// the way the native menu does, so the page popup's answer still travels
// through Nightly main, Stable and the host.
Menu.prototype.popup = function popup(this: Electron.Menu, options?: Electron.PopupOptions) {
  const labels = this.items.map((item) => item.label);
  emit("menu", { labels });
  const chosen = this.items.find((item) => item.label === menuPick && item.enabled);
  setImmediate(() => {
    chosen?.click();
    options?.callback?.();
  });
};

// The owner is the smoke; a Nightly client it can no longer see quits.
const ownerWatch = setInterval(() => {
  try {
    process.kill(ownerPid, 0);
  } catch {
    app.exit(4);
  }
}, 1_000);
ownerWatch.unref();
setTimeout(() => app.exit(3), MAX_LIFETIME_MS).unref();

// Nightly main reaches the host's Code approval routes with its own Node
// fetch. The harness reports each call's route, status, challenge and which
// authority it carried (header names only, never values), and after a
// cancellation it asks the host once to confirm that same challenge: a host
// that really dropped it refuses. That probe is the harness's, not the view's.
const APPROVAL_ROUTE =
  /^\/api\/desktop\/code-operation-approval-(challenges|confirmations|cancellations)$/;
const shippedFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const route = APPROVAL_ROUTE.exec(url.pathname)?.[1];
  const response = await shippedFetch(input, init);
  if (route === undefined) return response;
  const headers = new Headers(init?.headers);
  let challengeId: unknown;
  try {
    challengeId =
      route === "challenges"
        ? ((await response.clone().json()) as { challengeId?: unknown }).challengeId
        : (JSON.parse(String(init?.body ?? "{}")) as { challengeId?: unknown }).challengeId;
  } catch {
    challengeId = undefined;
  }
  emit("approval-route", {
    route,
    status: response.status,
    challengeId,
    nativeMain: headers.has(NATIVE_MAIN_AUTHORITY_HEADER),
    bridgeSecret: headers.has("x-octant-desktop-secret"),
  });
  if (route === "cancellations" && response.ok) {
    const probe = await shippedFetch(
      new URL("/api/desktop/code-operation-approval-confirmations", url.origin),
      { method: "POST", headers, body: JSON.stringify({ challengeId }) },
    );
    emit("approval-probe", { status: probe.status, challengeId });
  }
  return response;
}) as typeof globalThis.fetch;

// Electron holds `ready` until a top-level await in an ESM main settles.
async function main(): Promise<void> {
  let socket: Socket | undefined;
  let nextId = 1;
  const waiting = new Map<number, (reply: unknown) => void>();
  const connected = new Promise<void>((resolve) => {
    const next = connect(socketPath, resolve);
    next.on("error", () => undefined);
    next.once("close", () => {
      socket = undefined;
      for (const answer of waiting.values()) answer({ kind: "refused", reason: "unavailable" });
      waiting.clear();
    });
    createInterface({ input: next }).on("line", (line) => {
      const message = JSON.parse(line) as { id: number; reply: unknown };
      waiting.get(message.id)?.(message.reply);
      waiting.delete(message.id);
    });
    socket = next;
  });
  await connected;

  const exchange =
    (operation: "register" | "renew" | "revoke") =>
    (handle: string, generation: number): Promise<unknown> =>
      new Promise((resolve) => {
        if (socket === undefined || socket.destroyed) {
          resolve({ kind: "refused", reason: "unavailable" });
          return;
        }
        const id = nextId++;
        waiting.set(id, resolve);
        socket.write(`${JSON.stringify({ id, operation, handle, generation })}\n`);
        emit("native", { operation });
      });

  const harnessNative = {
    openWindow: exchange("register"),
    renewWindow: exchange("renew"),
    revokeWindow: exchange("revoke"),
    // The client side never listens for windows; Stable does.
    listenWindows: async () => ({ kind: "unavailable" }),
    replyWindow: () => false,
    stopWindows: async () => ({ kind: "closed" }),
  };

  const started = await runNightlyClient(desktopIdentity("nightly"), harnessNative, {
    handOff: () => undefined,
  });
  emit("client", { result: started.kind, marker: NIGHTLY_CLIENT_HARNESS_MARKER });
}

void main().catch((error: unknown) => {
  emit("client", { result: "failed", message: String(error) });
  app.exit(1);
});
