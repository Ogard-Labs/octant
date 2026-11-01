import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSurfaceHost, type BrowserSurfaceViewPort } from "./browserSurfaceHost";

/**
 * The desktop Browser's agent actions against a real Chromium page. Electron
 * is not here, so each view is a Playwright page standing in for a
 * WebContentsView: script runs in the page, and the debugger is the page's own
 * DevTools protocol session. Skipped where no Chromium is installed.
 */

const chrome = [
  process.env.OCTANT_BROWSER_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate !== undefined && existsSync(candidate));

const pages: Record<string, string> = {
  "/login": `<!doctype html><title>Sign in</title>
    <h1>Sign in</h1>
    <label for="user">Email</label><input id="user" value="ada@example.com">
    <label for="pass">Password</label><input id="pass" type="password" value="hunter2">
    <button>Continue</button>`,
  "/form": `<!doctype html><title>Form</title>
    <label>Name <input id="name"></label>
    <button id="save" onclick="document.title = 'Saved ' + document.getElementById('name').value">Save</button>
    <button onclick="document.getElementById('save').textContent = 'Store'">Rename save</button>`,
};

let server: Server;
let origin = "";
let browser: Browser | undefined;

beforeAll(async () => {
  server = createServer((request, response) => {
    const body = pages[new URL(request.url ?? "/", "http://localhost").pathname];
    response.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html" });
    response.end(body ?? "missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  if (chrome !== undefined) browser = await chromium.launch({ executablePath: chrome });
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

/** A WebContentsView port backed by one real page. */
async function pageView(): Promise<{ view: BrowserSurfaceViewPort; page: Page }> {
  if (browser === undefined) throw new Error("No Chromium.");
  const page = await browser.newPage();
  let title = "";
  let session: CDPSession | undefined;
  let attached = false;
  const refreshTitle = async () => {
    title = await page.title().catch(() => title);
  };
  const view: BrowserSurfaceViewPort = {
    setBounds: () => undefined,
    setVisible: () => undefined,
    webContents: {
      id: Math.floor(Math.random() * 1_000_000),
      capturePage: async () => {
        const bytes = await page.screenshot({ type: "jpeg", quality: 50 });
        return { isEmpty: () => false, toJPEG: () => bytes };
      },
      close: () => void page.close(),
      debugger: {
        attach: () => {
          attached = true;
        },
        detach: () => {
          attached = false;
          void session?.detach().catch(() => undefined);
          session = undefined;
        },
        isAttached: () => attached,
        sendCommand: async (method, parameters) => {
          session ??= await page.context().newCDPSession(page);
          const answer = await session.send(method as "Runtime.evaluate", parameters as never);
          await refreshTitle();
          return answer;
        },
      },
      executeJavaScriptInIsolatedWorld: async (_world, scripts) => {
        const answer = await page.evaluate(scripts[0]?.code ?? "undefined");
        await refreshTitle();
        return answer;
      },
      getTitle: () => title,
      getURL: () => (page.url() === "about:blank" ? "" : page.url()),
      isDestroyed: () => page.isClosed(),
      isLoading: () => false,
      loadURL: async (url) => {
        await page.goto(url);
        await refreshTitle();
      },
      mainFrame: {
        get framesInSubtree() {
          return page.frames().map((frame) => ({
            executeJavaScript: (code: string) => frame.evaluate(code),
          }));
        },
      },
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
        goBack: () => undefined,
        goForward: () => undefined,
      },
      on: () => undefined,
      reload: () => undefined,
      session: {
        on: () => undefined,
        setDevicePermissionHandler: () => undefined,
        setDisplayMediaRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
        setPermissionRequestHandler: () => undefined,
      },
      setWindowOpenHandler: () => undefined,
      stop: () => undefined,
    },
  };
  return { view, page };
}

async function surface(path: string) {
  const { view, page } = await pageView();
  const host = createBrowserSurfaceHost({ createView: () => view });
  const contextId = crypto.randomUUID();
  await host.createContext({
    contextId,
    owner: { windowId: "window-a", threadId: crypto.randomUUID() },
    policy: {
      profileMode: "isolated",
      allowedOrigins: [origin],
      credentialFieldProtection: true,
      maxConcurrentTabs: 4,
      sessionTimeoutMs: 300_000,
    },
  });
  await host.act(contextId, { kind: "navigate", target: `${origin}${path}` });
  return { host, contextId, page };
}

function entry(
  refs: ReadonlyArray<{ readonly ref: string; readonly name: string }> | undefined,
  name: string,
) {
  const found = refs?.find((ref) => ref.name === name);
  if (found === undefined) throw new Error(`No ref named ${name}.`);
  return found as {
    readonly ref: string;
    readonly selector: string;
    readonly role: string;
    readonly name: string;
  };
}

describe.skipIf(chrome === undefined)("the desktop Browser on a real page", () => {
  it("reads a snapshot with refs and names a password field without its value", async () => {
    const { host, contextId, page } = await surface("/login");
    const observed = await host.act(contextId, { kind: "snapshot" });
    expect(observed.snapshot).toMatch(/- textbox "Password" \[ref=e\d+\] protected$/m);
    expect(observed.snapshot).not.toContain("hunter2");
    expect(observed.snapshot).not.toContain("ada@example.com");
    expect(observed.screenshotDataUrl).toBeUndefined();
    expect(entry(observed.snapshotRefs, "Continue").role).toBe("button");
    await page.close();
  });

  it("acts on a ref's element and refuses one the page no longer matches", async () => {
    const { host, contextId, page } = await surface("/form");
    const observed = await host.act(contextId, { kind: "snapshot" });
    const save = entry(observed.snapshotRefs, "Save");
    const name = entry(observed.snapshotRefs, "Name");
    await host.act(contextId, {
      kind: "type",
      target: name.selector,
      value: "Ada",
      expected: { role: name.role, name: name.name },
    });
    const clicked = await host.act(contextId, {
      kind: "click",
      target: save.selector,
      expected: { role: save.role, name: save.name },
    });
    expect(clicked.title).toBe("Saved Ada");
    const rename = entry(observed.snapshotRefs, "Rename save");
    await host.act(contextId, { kind: "click", target: rename.selector });
    await expect(
      host.act(contextId, {
        kind: "click",
        target: save.selector,
        expected: { role: save.role, name: save.name },
      }),
    ).rejects.toThrow(/changed since the snapshot/);
    await page.close();
  });
});
