import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  "/controls": `<!doctype html><title>Controls</title>
    <nav id="menu" onmouseenter="document.getElementById('item').hidden = false">Menu
      <a id="item" href="/form" hidden>Open settings</a></nav>
    <label for="size">Size</label>
    <select id="size" onchange="document.title = 'Size ' + this.value">
      <option value="s">Small</option><option value="l">Large</option>
    </select>
    <div id="card" style="width:60px;height:30px" onpointerdown="window.dragging = true">Card</div>
    <div id="done" style="width:60px;height:30px;margin-top:40px" onpointerup="if (window.dragging) document.title = 'Dropped card'">Done</div>
    <form onsubmit="event.preventDefault(); document.title = 'Submitted'"><input id="keys" aria-label="Keys" onkeydown="if (event.ctrlKey) document.title = 'Chord ' + event.key"></form>
    <input id="file" type="file" onchange="document.title = 'Attached ' + this.files[0].name + ' ' + this.files[0].size">`,
  "/greets": `<!doctype html><title>Greeting</title><script>alert("Welcome"); document.title = "Greeted";</script>`,
  "/slow": `<!doctype html><title>Slow</title>
    <button id="go" onclick="setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Saved at last'; document.body.append(p); document.getElementById('go').disabled = true; }, 400)">Go</button>
    <button id="later" onclick="setTimeout(() => { document.title = 'Settled'; }, 150)">Later</button>
    <button id="late" onclick="setTimeout(() => alert('late news'), 800)">Late</button>
    <button id="ask" onclick="const ok = confirm('Delete everything?'); alert(ok ? 'deleted' : 'kept'); document.title = ok ? 'Deleted' : 'Kept'">Ask</button>
    <p>Width <span id="width"></span></p>
    <script>const show = () => { document.getElementById('width').textContent = String(innerWidth); }; show(); addEventListener('resize', show);</script>`,
  "/html-drag": `<!doctype html><title>Drag</title>
    <div id="card" draggable="true" style="width:60px;height:30px" ondragstart="event.dataTransfer.setData('text', 'card')">Card</div>
    <div id="done" style="width:60px;height:30px;margin-top:40px" ondragover="event.preventDefault()" ondrop="event.preventDefault(); document.title = 'Dropped ' + event.dataTransfer.getData('text')">Done</div>`,
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
    response.writeHead(body === undefined ? 404 : 200, {
      "content-type": "text/html",
    });
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
async function pageView(): Promise<{
  view: BrowserSurfaceViewPort;
  page: Page;
}> {
  if (browser === undefined) throw new Error("No Chromium.");
  const page = await browser.newPage();
  let title = "";
  let session: CDPSession | undefined;
  let attached = false;
  const messageListeners = new Set<(event: unknown, method: string, params: unknown) => void>();
  const openSession = async (): Promise<CDPSession> => {
    if (session !== undefined) return session;
    const opened = await page.context().newCDPSession(page);
    opened.on("Page.javascriptDialogOpening", (params) => {
      for (const listener of messageListeners) listener({}, "Page.javascriptDialogOpening", params);
    });
    session = opened;
    return opened;
  };
  // Electron answers no dialog by itself here; leave each one to the host's
  // protocol session, as the app's own view would.
  page.on("dialog", () => undefined);
  const refreshTitle = async () => {
    title = await page.evaluate(() => document.title).catch(() => title);
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
          const answer = await (
            await openSession()
          ).send(method as "Runtime.evaluate", parameters as never);
          await refreshTitle();
          return answer;
        },
        on: (_event, listener) => void messageListeners.add(listener),
        removeListener: (_event, listener) => void messageListeners.delete(listener),
      },
      enableDeviceEmulation: (parameters) => void page.setViewportSize(parameters.viewSize),
      disableDeviceEmulation: () => void page.setViewportSize({ width: 1280, height: 720 }),
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

async function surface(path: string, views = 1) {
  const pool = await Promise.all(Array.from({ length: views }, () => pageView()));
  const page = pool[0]?.page;
  if (page === undefined) throw new Error("No page.");
  let next = 0;
  const host = createBrowserSurfaceHost({
    createView: () => {
      const created = pool[next]?.view;
      next += 1;
      if (created === undefined) throw new Error("No page left for another tab.");
      return created;
    },
  });
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
  const opened = await host.act(contextId, {
    kind: "navigate",
    target: `${origin}${path}`,
  });
  return { host, contextId, page, opened };
}

/**
 * One host with two threads' contexts in the same window, each on its own real
 * page, the way two threads of a Project work at once. Views are handed out in
 * the order contexts and tabs ask for them.
 */
async function twoThreads(firstPath: string, secondPath: string) {
  const pool = await Promise.all(Array.from({ length: 4 }, () => pageView()));
  let next = 0;
  const host = createBrowserSurfaceHost({
    createView: () => {
      const created = pool[next]?.view;
      next += 1;
      if (created === undefined) throw new Error("No page left for another tab.");
      return created;
    },
  });
  const policy = {
    profileMode: "isolated" as const,
    allowedOrigins: [origin],
    credentialFieldProtection: true as const,
    maxConcurrentTabs: 4,
    sessionTimeoutMs: 300_000,
  };
  const firstOwner = { windowId: "window-a", threadId: crypto.randomUUID() };
  const secondOwner = { windowId: "window-a", threadId: crypto.randomUUID() };
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await host.createContext({ contextId: first, owner: firstOwner, policy });
  await host.createContext({ contextId: second, owner: secondOwner, policy });
  await host.act(first, { kind: "navigate", target: `${origin}${firstPath}` });
  await host.act(second, {
    kind: "navigate",
    target: `${origin}${secondPath}`,
  });
  const close = () => Promise.all(pool.map((entry) => entry.page.close()));
  const firstPage = pool[0]?.page;
  if (firstPage === undefined) throw new Error("No page.");
  return { host, first, second, firstOwner, secondOwner, firstPage, close };
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

// A real browser on a shared CI runner can take longer than the 5 s default.
describe.skipIf(chrome === undefined)(
  "the desktop Browser on a real page",
  { timeout: 30_000 },
  () => {
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
        expected: { role: name.role, name: name.name, url: `${origin}/form` },
      });
      const clicked = await host.act(contextId, {
        kind: "click",
        target: save.selector,
        expected: { role: save.role, name: save.name, url: `${origin}/form` },
      });
      expect(clicked.title).toBe("Saved Ada");
      const rename = entry(observed.snapshotRefs, "Rename save");
      await host.act(contextId, { kind: "click", target: rename.selector });
      await expect(
        host.act(contextId, {
          kind: "click",
          target: save.selector,
          expected: { role: save.role, name: save.name, url: `${origin}/form` },
        }),
      ).rejects.toThrow(/changed since the snapshot/);
      await page.close();
    });

    it("takes no picture and returns no text after an action unless the call asks", async () => {
      const { host, contextId, page } = await surface("/form");
      const clicked = await host.act(contextId, {
        kind: "click",
        target: "#save",
      });
      expect(clicked.screenshotDataUrl).toBeUndefined();
      expect(clicked.extractedText).toBeUndefined();
      expect(clicked.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const asked = await host.act(contextId, {
        kind: "click",
        target: "#save",
        include: ["screenshot", "text", "snapshot"],
      });
      expect(asked.screenshotDataUrl).toMatch(/^data:image\/jpeg;base64,/);
      expect(asked.extractedText).toContain("Save");
      expect(asked.snapshot).toMatch(/- button "Save" \[ref=e\d+\]/);
      const pictured = await host.act(contextId, { kind: "screenshot" });
      expect(pictured.screenshotDataUrl).toMatch(/^data:image\/jpeg;base64,/);
      expect(pictured.extractedText).toBeUndefined();
      const preview = await host.peek(contextId);
      expect(preview.screenshotDataUrl).toMatch(/^data:image\/jpeg;base64,/);
      await page.close();
    });

    it("hovers, chooses an option, drags, presses chords and Enter, and uploads a file", async () => {
      const { host, contextId, page } = await surface("/controls");
      await host.act(contextId, { kind: "hover", target: "#menu" });
      expect(await page.isVisible("#item")).toBe(true);
      expect(
        (
          await host.act(contextId, {
            kind: "select",
            target: "#size",
            value: "Large",
          })
        ).title,
      ).toBe("Size l");
      await expect(
        host.act(contextId, { kind: "select", target: "#size", value: "Huge" }),
      ).rejects.toThrow(/no option/);
      expect(
        (
          await host.act(contextId, {
            kind: "drag",
            target: "#card",
            destination: "#done",
          })
        ).title,
      ).toBe("Dropped card");
      await host.act(contextId, { kind: "click", target: "#keys" });
      expect((await host.act(contextId, { kind: "press", value: "Control+B" })).title).toBe(
        "Chord b",
      );
      expect((await host.act(contextId, { kind: "press", value: "Enter" })).title).toBe(
        "Submitted",
      );
      const folder = await mkdtemp(join(tmpdir(), "octant-upload-"));
      try {
        await writeFile(join(folder, "notes.txt"), "hello");
        const sent = await host.act(contextId, {
          kind: "upload",
          target: "#file",
          files: [join(folder, "notes.txt")],
        });
        expect(sent.title).toBe("Attached notes.txt 5");
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
      await page.close();
    });

    it("opens, lists, switches, and closes the agent's tabs inside the allowed origin", async () => {
      const { host, contextId, page } = await surface("/form", 3);
      const opened = await host.act(contextId, {
        kind: "tab-open",
        target: `${origin}/login`,
      });
      expect(opened.tabs).toEqual([
        { tabId: "t1", url: `${origin}/form`, title: "Form", active: false },
        { tabId: "t2", url: `${origin}/login`, title: "Sign in", active: true },
      ]);
      expect((await host.act(contextId, { kind: "tab-select", tabId: "t1" })).title).toBe("Form");
      const closed = await host.act(contextId, {
        kind: "tab-close",
        tabId: "t2",
      });
      expect(closed.tabs).toEqual([
        { tabId: "t1", url: `${origin}/form`, title: "Form", active: true },
      ]);
      await expect(host.act(contextId, { kind: "tab-close", tabId: "t1" })).rejects.toThrow(
        /only tab/,
      );
      await expect(
        host.act(contextId, {
          kind: "tab-open",
          target: "https://example.com/",
        }),
      ).rejects.toThrow(/allowlist/);
      await page.close();
    });

    it("drags so a page listening for HTML drag and drop sees the drop too", async () => {
      const { host, contextId, page } = await surface("/html-drag");
      const dragged = await host.act(contextId, {
        kind: "drag",
        target: "#card",
        destination: "#done",
      });
      expect(dragged.title).toBe("Dropped card");
      await page.close();
    });

    it("waits for conditions, settles after an action, answers dialogs, and resizes", async () => {
      const { host, contextId, page } = await surface("/slow");
      await host.act(contextId, { kind: "click", target: "#go" });
      await host.act(contextId, {
        kind: "wait",
        waitFor: {
          conditions: [
            { kind: "text", text: "Saved at last", present: true },
            { kind: "element", target: "#go", state: "disabled" },
          ],
          match: "all",
          timeoutMs: 5_000,
        },
      });
      await expect(
        host.act(contextId, {
          kind: "wait",
          waitFor: {
            conditions: [{ kind: "text", text: "Never there", present: true }],
            match: "all",
            timeoutMs: 300,
          },
        }),
      ).rejects.toThrow(/timed out after 300 ms/);
      expect((await host.act(contextId, { kind: "click", target: "#later" })).title).toBe(
        "Settled",
      );
      const asked = await host.act(contextId, {
        kind: "click",
        target: "#ask",
      });
      expect(asked.title).toBe("Kept");
      expect(asked.dialogs).toEqual([
        { type: "confirm", message: "Delete everything?", answer: "dismissed" },
        { type: "alert", message: "kept", answer: "accepted" },
      ]);
      const narrow = await host.act(contextId, {
        kind: "resize",
        viewport: { width: 390, height: 844 },
        include: ["text"],
      });
      expect(narrow.extractedText).toContain("Width 390");
      const restored = await host.act(contextId, {
        kind: "resize",
        include: ["text"],
      });
      expect(restored.extractedText).toContain("Width 1280");
      await page.close();
    });

    it("answers a dialog the very first page raises as it loads, and one a new tab raises", async () => {
      const { host, contextId, page, opened } = await surface("/greets", 3);
      expect(opened.dialogs).toEqual([{ type: "alert", message: "Welcome", answer: "accepted" }]);
      expect(opened.title).toBe("Greeted");
      const tabs = await host.act(contextId, {
        kind: "tab-open",
        target: `${origin}/greets`,
      });
      expect(tabs.dialogs).toEqual([{ type: "alert", message: "Welcome", answer: "accepted" }]);
      expect(tabs.tabs?.[1]).toMatchObject({ title: "Greeted", active: true });
      await page.close();
    });

    it("lets two threads' pages work at once: one waits on its page while the other acts", async () => {
      const { host, first, second, firstPage, close } = await twoThreads("/slow", "/form");
      const finished: string[] = [];
      // The first thread waits for text that only appears once the test says so,
      // after the second thread has finished. If the host held one action at a
      // time across surfaces, the second thread's actions would queue behind
      // this wait and the test would stall to its timeout.
      const waiting = host
        .act(first, {
          kind: "wait",
          waitFor: {
            conditions: [{ kind: "text", text: "Released", present: true }],
            match: "all",
            timeoutMs: 20_000,
          },
        })
        .then((observed) => (finished.push("first-wait"), observed));
      // Behind the wait on its own page, the first thread's next action queues.
      const queued = host
        .act(first, { kind: "extract-text" })
        .then((observed) => (finished.push("first-queued"), observed));

      await host.act(second, { kind: "type", target: "#name", value: "Ada" });
      const saved = await host.act(second, { kind: "click", target: "#save" });
      finished.push("second-done");
      expect(saved.title).toBe("Saved Ada");
      expect(finished).toEqual(["second-done"]);

      await firstPage.evaluate(() => {
        const note = document.createElement("p");
        note.textContent = "Released";
        document.body.append(note);
      });
      await waiting;
      const afterQueue = await queued;
      expect(finished).toEqual(["second-done", "first-wait", "first-queued"]);
      // Each action reached its own page, never the other's.
      expect(afterQueue.url).toBe(`${origin}/slow`);
      expect(afterQueue.extractedText).toContain("Released");
      expect((await host.act(second, { kind: "extract-text" })).url).toBe(`${origin}/form`);
      await close();
    });

    it("interleaves actions of two pages without crossing them", async () => {
      const { host, first, second, close } = await twoThreads("/controls", "/form");
      const rounds = Array.from({ length: 4 }, (_, round) => round);
      const results = await Promise.all(
        rounds.flatMap((round) => [
          host.act(first, {
            kind: "select",
            target: "#size",
            value: round % 2 === 0 ? "Large" : "Small",
          }),
          host.act(second, { kind: "click", target: "#save" }),
        ]),
      );
      const own = (observed: { readonly url?: string }, path: string) =>
        observed.url === `${origin}${path}`;
      expect(results.filter((observed) => own(observed, "/controls"))).toHaveLength(4);
      expect(results.filter((observed) => own(observed, "/form"))).toHaveLength(4);
      // Each page kept its own actions in the order they were asked.
      expect((await host.act(first, { kind: "extract-text" })).title).toBe("Size s");
      expect((await host.act(second, { kind: "extract-text" })).title).toBe("Saved");
      await close();
    });

    it("keeps each context's tabs to its own thread, however a tab id is guessed", async () => {
      const { host, first, second, firstOwner, secondOwner, close } = await twoThreads(
        "/slow",
        "/form",
      );
      await host.act(first, { kind: "tab-open", target: `${origin}/other` });
      const firstTabs = (await host.act(first, { kind: "tab-list" })).tabs ?? [];
      expect(firstTabs).toHaveLength(2);
      const frontBefore = firstTabs.find((tab) => tab.active)?.tabId;

      // The second thread has one tab. The first thread's second tab is none of its.
      expect((await host.act(second, { kind: "tab-list" })).tabs).toHaveLength(1);
      await expect(host.act(second, { kind: "tab-select", tabId: "t2" })).rejects.toThrow();
      await expect(host.act(second, { kind: "tab-close", tabId: "t2" })).rejects.toThrow();
      // The first thread's real, host-side tab id is no tab of the second.
      const hostTabId = host.state(first).tabs?.[0]?.tabId;
      await expect(
        host.tabCommand(second, secondOwner, {
          kind: "select",
          tabId: hostTabId ?? "x",
        }),
      ).rejects.toThrow(/unknown/);
      // A tab command names its owner: the first thread's owner is no owner of the second.
      await expect(host.tabCommand(second, firstOwner, { kind: "open" })).rejects.toThrow(
        /does not own/,
      );

      expect((await host.act(second, { kind: "tab-list" })).tabs).toHaveLength(1);
      const firstAfter = (await host.act(first, { kind: "tab-list" })).tabs ?? [];
      expect(firstAfter).toHaveLength(2);
      expect(firstAfter.find((tab) => tab.active)?.tabId).toBe(frontBefore);
      await close();
    });

    it("reports a dialog answered during an action that then failed with the next answer", async () => {
      const { host, contextId, page } = await surface("/slow");
      await host.act(contextId, { kind: "click", target: "#late" });
      await expect(
        host.act(contextId, {
          kind: "wait",
          waitFor: {
            conditions: [{ kind: "text", text: "Never there", present: true }],
            match: "all",
            timeoutMs: 2_000,
          },
        }),
      ).rejects.toThrow(/timed out/);
      const next = await host.act(contextId, { kind: "extract-text" });
      expect(next.dialogs).toEqual([{ type: "alert", message: "late news", answer: "accepted" }]);
      await page.close();
    });
  },
);
