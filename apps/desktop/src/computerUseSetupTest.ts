import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { BrowserWindow, dialog } from "electron";
import type { ComputerDriverRuntime } from "./computerUseSdkRuntime";
import { probeComputerUse } from "./computerUseProbe";

/** This diagnostic never enters the agent tool transport or grants an app lease. */
export async function testComputerUseWindow(
  parent: BrowserWindow,
  runtime: ComputerDriverRuntime,
  signal: AbortSignal,
): Promise<boolean> {
  const approval = await dialog.showMessageBox(parent, {
    signal,
    type: "question",
    title: "Test Computer use",
    message: "Allow Octant to capture and click its temporary test window?",
    detail:
      "This test uses only its own window. Nothing is sent to an AI provider or saved. Your other applications are not approved by this test.",
    buttons: ["Cancel", "Allow test"],
    defaultId: 0,
    cancelId: 0,
  });
  if (approval.response !== 1) return false;
  signal.throwIfAborted();
  if (parent.isDestroyed()) return false;
  const nonce = randomUUID();
  const label = `Test button ${nonce}`;
  const window = new BrowserWindow({
    parent,
    width: 480,
    height: 280,
    title: "Octant Computer use test",
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: `octant-setup-${nonce}`,
    },
  });
  const cancel = () => {
    if (!window.isDestroyed()) window.destroy();
  };
  signal.addEventListener("abort", cancel, { once: true });
  parent.once("closed", cancel);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  try {
    const painted = once(window, "ready-to-show", { signal });
    void painted.catch(() => undefined);
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'"><title>Octant Computer use test</title></head>
<body><h1>Testing Computer use</h1><p>Octant will capture this window and press the test button. Please wait.</p>
<button aria-label="${label}" id="test">Test button</button><p id="result" role="status">Waiting for the driver</p>
<script nonce="${nonce}">document.getElementById('test').addEventListener('click', event => { if (event.isTrusted) { document.body.dataset.clicked = 'yes'; document.getElementById('result').textContent = 'Click verified'; } });</script></body></html>`)}`,
    );
    await painted;
    signal.throwIfAborted();
    window.show();
    const windowId = Number(window.getMediaSourceId().split(":")[1]);
    if (!Number.isSafeInteger(windowId) || windowId <= 0)
      throw new Error("The test window is unavailable.");
    await probeComputerUse(
      runtime,
      {
        windowId,
        buttonLabel: label,
        isOpen: () => !window.isDestroyed(),
        wasClicked: async () => {
          for (let attempt = 0; attempt < 20; attempt += 1) {
            signal.throwIfAborted();
            if (window.isDestroyed()) return false;
            if (
              (await window.webContents.executeJavaScript(
                "document.body.dataset.clicked === 'yes'",
              )) === true
            )
              return true;
            await delay(100, undefined, { signal });
          }
          return false;
        },
      },
      signal,
    );
    return true;
  } finally {
    signal.removeEventListener("abort", cancel);
    parent.removeListener("closed", cancel);
    cancel();
  }
}
