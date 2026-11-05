import { observeBrowserEditableTarget } from "./browserEditableObservation";
import { readBrowserEditableTarget } from "./browserEditableTarget";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inflateSync } from "node:zlib";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrowserTargetStaleError,
  createBrowserSurfaceHost,
  type BrowserSurfaceViewPort,
} from "./browserSurfaceHost";

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
  "/ime-editors": `<input id="a" value="private-fixture"><textarea id="b"></textarea><input id="password" type="password" value="fixture-password"><div id="custom" contenteditable="true">fixture</div><input id="readonly" readonly><script>for(const type of ['focusin','focusout'])window.addEventListener(type,event=>event.stopImmediatePropagation(),true)</script>`,
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
  "/device": `<!doctype html><title>Device</title><meta name="viewport" content="width=device-width, initial-scale=1">
    <button id="tap" style="width:120px;height:48px">Tap</button>
    <p id="log"></p>
    <script>
      const log = (what) => { document.getElementById('log').textContent += what + ' '; };
      addEventListener('touchstart', () => log('touchstart'));
      document.getElementById('tap').addEventListener('click', () => log('click'));
    </script>`,
  "/html-drag": `<!doctype html><title>Drag</title>
    <div id="card" draggable="true" style="width:60px;height:30px" ondragstart="event.dataTransfer.setData('text', 'card')">Card</div>
    <div id="done" style="width:60px;height:30px;margin-top:40px" ondragover="event.preventDefault()" ondrop="event.preventDefault(); document.title = 'Dropped ' + event.dataTransfer.getData('text')">Done</div>`,
  "/downloads": `<!doctype html><title>Downloads</title>
    <a id="report" href="/dl/report.pdf">Report</a>
    <a id="program" href="/dl/notes.txt">Notes</a>`,
  "/framed": `<!doctype html><title>Framed</title>
    <iframe title="Search" src="/inner"></iframe>
    <iframe title="Elsewhere" src="{{other}}/remote" width="600" height="300" style="transform: scale(0.5); transform-origin: 0 0"></iframe>
    <shadow-card id="card"></shadow-card>
    <script>
      document.getElementById("card").attachShadow({ mode: "open" }).innerHTML = '<p><button>One</button></p><button onclick="document.title = \\'Shadow saved\\'">Shadow save</button><div><button id="deep" onclick="document.title = \\'Deep saved\\'">Deep save</button></div>';
      addEventListener("message", (event) => { document.title = String(event.data); });
    </script>`,
  "/inner": `<!doctype html><title>Inner</title>
    <label for="q">Query</label><input id="q">
    <button onclick="top.document.title = 'Found ' + document.getElementById('q').value">Find</button>`,
  "/remote": `<!doctype html><title>Remote</title>
    <label for="r">Remote query</label><input id="r">
    <button style="margin-left: 300px" onclick="parent.postMessage('Remote ' + document.getElementById('r').value, '*')">Remote find</button>`,
  "/framed-login": `<!doctype html><title>Framed sign-in</title>
    <label for="mail">Email</label><input id="mail" value="ada@example.com">
    <iframe title="Sign-in" src="{{other}}/remote-login"></iframe>`,
  "/remote-login": `<!doctype html><title>Remote sign-in</title>
    <label for="code">Password</label><input id="code" type="password" value="hunter2">`,
  "/audit": `<!doctype html><html><head><title>Audit</title>
    <style>.faint { color: #aaaaaa; background: #ffffff } .hero { background: linear-gradient(#000, #333); color: #fff }</style></head>
    <body><h1>Shop</h1><h3>Deals</h3>
    <img id="bare" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'/%3E">
    <img alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'/%3E">
    <button id="icon"><svg aria-hidden="true" width="20" height="20"></svg></button>
    <button><img alt="Search" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'/%3E"></button>
    <button aria-label="Close">×</button>
    <button id="ghost"><span hidden>Save</span><span style="display:none">Save</span></button>
    <button id="muted"><span aria-hidden="true">Mute</span></button>
    <div inert><h2>Inactive panel</h2><h5>Skipped level</h5><button id="asleep"></button><a href="/form"></a><input></div>
    <span id="draft-label" hidden>Save draft</span><button aria-labelledby="draft-label"></button>
    <p>See <a id="empty" href="/form"></a> and our <a href="/form">deals</a> today.</p>
    <input id="unlabelled"><label for="mail">Email</label><input id="mail"><input placeholder="Search">
    <p class="faint">Faint words</p><p>Plain words</p><div class="hero">Over a gradient</div>
    <div style="opacity:0.1"><p style="color:#000;background:#fff">Ghost words</p></div>
    <div aria-hidden="true"><a href="/form">Hidden link</a><a href="/form" tabindex="-1">Skipped</a></div>
    <span id="hint">Hint</span><span id="hint">Again</span><input aria-describedby="hint" aria-label="Code">
    <div><button id="tiny-a" style="width:16px;height:16px;padding:0;border:0">A</button><button id="tiny-b" style="width:16px;height:16px;padding:0;border:0;margin-left:2px">B</button></div>
    <iframe title="Ad" srcdoc="<p>Ad</p>"></iframe></body></html>`,
  // Typed text in a rich editor, and text a shadow root's slot draws over its own backdrop.
  "/audit-private": `<!doctype html><html lang="en"><title>Private</title><body style="background:#fff">
    <h1>Notes</h1><div contenteditable aria-label="Password"><span style="color:#999;background:#fff">secret</span><h3>Typed heading</h3><span id="typed">typed name</span></div>
    <div aria-hidden="true"><a href="/form" aria-labelledby="typed">Hidden link</a></div>
    <slot-card id="dark"><span style="color:#555">Slotted words</span></slot-card>
    <slot-card id="faded"><span style="color:#000">Faded words</span></slot-card>
    <script>
      document.getElementById("dark").attachShadow({ mode: "open" }).innerHTML = '<div style="background:#000"><slot></slot></div>';
      document.getElementById("faded").attachShadow({ mode: "open" }).innerHTML = '<div style="opacity:0.5"><slot></slot></div>';
    </script></body></html>`,
  // A shadow root that draws its host's heading before its own, and its host's text over its backdrop.
  "/audit-slots": `<!doctype html><html lang="en"><title>Slots</title><body style="background:#fff">
    <h1>Shop</h1>
    <slot-panel id="panel"><h2>Summary</h2></slot-panel>
    <slot-card id="words">Host words</slot-card>
    <script>
      document.getElementById("panel").attachShadow({ mode: "open" }).innerHTML = '<slot></slot><h3>Details</h3>';
      document.getElementById("words").attachShadow({ mode: "open" }).innerHTML = '<div style="background:#000;color:#555"><slot></slot></div>';
    </script></body></html>`,
  // More touch targets than any one slice, with the only crowded pair last.
  "/audit-targets": `<!doctype html><html lang="en"><title>Targets</title><body>
    <div style="display:flex;flex-wrap:wrap;gap:8px">${'<button style="width:32px;height:32px">x</button>'.repeat(1_100)}</div>
    <div><button id="late-a" style="width:16px;height:16px;padding:0;border:0">A</button><button id="late-b" style="width:16px;height:16px;padding:0;border:0;margin-left:2px">B</button></div></body></html>`,
  // Every native control the audit names, named and unnamed, to hold against the browser's own names.
  "/audit-names": `<!doctype html><html lang="en"><title>Names</title><body>
    <input data-control id="sub" type="submit"><input data-control id="sube" type="submit" value=""><input data-control id="subs" type="submit" value=" ">
    <input data-control id="res" type="reset"><input data-control id="rese" type="reset" value="">
    <input data-control id="btn" type="button"><input data-control id="btnt" type="button" title="Tip">
    <button data-control id="b"></button><label for="bl">Labelled</label><button data-control id="bl"></button><button data-control id="bt" title="Tip"></button>
    <details><summary data-control id="sum"></summary>More</details><details><summary data-control id="sumt">Open</summary>More</details>
    <input data-control id="img" type="image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E">
    <input data-control id="imgv" type="image" value="Go" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E">
    <img data-control id="im" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E">
    <img data-control id="imt" title="Tip" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E">
    <input data-control id="file" type="file"><label>Upload <input data-control id="filel" type="file"></label>
    <select data-control id="sel"><option>One</option></select><select data-control id="selp" placeholder="Pick"><option>One</option></select><select data-control id="selt" title="Tip"><option>One</option></select>
    <textarea data-control id="ta"></textarea><textarea data-control id="tap" placeholder="Write"></textarea>
    <input data-control id="txt"><input data-control id="txtp" placeholder="Search"><input data-control id="txtt" title="Tip">
    <input data-control id="lb" aria-labelledby="missing"><input data-control id="al" aria-label="  "><input data-control id="chk" type="checkbox">
    <a data-control id="a" href="/form"></a><a data-control id="at" href="/form" title="Tip"></a></body></html>`,
  // Text over backgrounds the browser does not paint, and over ones it paints in ways a colour cannot say.
  "/audit-paint": `<!doctype html><html lang="en"><head><title>Paint</title>
    <style>.overlay::before { content: ""; position: absolute; inset: 0; background: #000; z-index: -1 }</style></head>
    <body style="background:#fff">
    <p style="color:#000;background:#fff"><span style="display:contents;background:#000">Readable contents</span></p>
    <div style="visibility:hidden;background:#000"><p style="visibility:visible;color:#000">Readable visible</p></div>
    <p style="color:#fff;background:linear-gradient(#000, #000)">Gradient</p>
    <p style="color:transparent;background:#fff;background-clip:text;-webkit-background-clip:text">Clipped</p>
    <p class="overlay" style="position:relative;color:#fff">Pseudo backdrop</p>
    <div style="backdrop-filter:invert(1)"><p style="color:#eee">Backdrop filtered</p></div>
    <div style="-webkit-mask-image:linear-gradient(#000, transparent);mask-image:linear-gradient(#000, transparent)"><p style="color:#000">Masked</p></div>
    <p style="mix-blend-mode:difference;color:#fff">Blended</p>
    <p style="filter:invert(1);color:#fff">Filtered</p></body></html>`,
  // More elements than the audit reads, with a referenced duplicate id past the end.
  "/audit-large": `<!doctype html><html lang="en"><title>Large</title><body>
    ${"<div></div>".repeat(6_100)}
    <span id="far">Far</span><span id="far">Again</span><input aria-describedby="far" aria-label="Late"></body></html>`,
  "/perf": `<!doctype html><html lang="en"><title>Perf</title>
    <div id="above"></div>
    <h1 style="font-size:64px">Fast enough</h1>
    <img src="/pixel.svg?token=s3cret" width="300" height="200" alt="Pixel">
    <script>
      addEventListener("load", () => setTimeout(() => {
        document.getElementById("above").style.height = "120px";
        const start = performance.now(); while (performance.now() - start < 150) {}
      }, 100));
    </script></html>`,
  "/red": `<!doctype html><title>Red</title><style>html, body { margin: 0; height: 100%; background: rgb(220, 30, 30); }</style><p>Approved</p>`,
  "/blue": `<!doctype html><title>Blue</title><style>html, body { margin: 0; height: 100%; background: rgb(30, 30, 220); }</style><p>Elsewhere</p>`,
  "/form": `<!doctype html><title>Form</title>
    <label>Name <input id="name"></label>
    <button id="save" onclick="document.title = 'Saved ' + document.getElementById('name').value">Save</button>
    <button onclick="document.getElementById('save').textContent = 'Store'">Rename save</button>`,
};

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n");
const ELF_BYTES = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
const attachments: Record<string, { readonly name: string; readonly body: Buffer }> = {
  "/dl/report.pdf": { name: "report.pdf", body: PDF_BYTES },
  "/dl/notes.txt": { name: "notes.txt", body: ELF_BYTES },
};

let server: Server;
let origin = "";
let browser: Browser | undefined;

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const attachment = attachments[path];
    if (attachment !== undefined) {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${attachment.name}"`,
      });
      response.end(attachment.body);
      return;
    }
    if (path === "/pixel.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml" });
      response.end(
        "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect width='300' height='200'/></svg>",
      );
      return;
    }
    // A frame on the server's other name is on another site, in its own process.
    const other = `http://localhost:${String((server.address() as AddressInfo).port)}`;
    const body = pages[path];
    response.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html" });
    response.end(body?.replaceAll("{{other}}", other) ?? "missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  // Electron keeps each site in its own process; Playwright turns that off
  // unless asked, and a frame on another site would then share the page's.
  if (chrome !== undefined) {
    browser = await chromium.launch({ executablePath: chrome, args: ["--site-per-process"] });
  }
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

/** A WebContentsView port backed by one real page. */
async function pageView(): Promise<{
  view: BrowserSurfaceViewPort;
  page: Page;
  /** Plays the person's key into the page, as Electron's input event does. */
  personKey: () => void;
}> {
  if (browser === undefined) throw new Error("No Chromium.");
  // An Electron view has no color scheme of its own: it follows the machine.
  const page = await (await browser.newContext({ colorScheme: null })).newPage();
  let title = "";
  let session: CDPSession | undefined;
  let attached = false;
  const inputListeners = new Set<(event: unknown, input: unknown) => void>();
  const messageListeners = new Set<
    (event: unknown, method: string, params: unknown, sessionId?: string) => void
  >();
  // Frames on another site, each with its own protocol session, as Electron's
  // debugger announces them once the host asks to attach to them.
  const frameSessions = new Map<string, CDPSession>();
  // Electron applies a device change synchronously; this stand-in finishes it
  // before the page is next read, which is the same order of events.
  let deviceChange: Promise<void> = Promise.resolve();
  let deviceSessionOpened: Promise<CDPSession> | undefined;
  const deviceSession = () => {
    deviceSessionOpened ??= page.context().newCDPSession(page);
    return deviceSessionOpened;
  };
  const openSession = async (): Promise<CDPSession> => {
    if (session !== undefined) return session;
    const opened = await page.context().newCDPSession(page);
    opened.on("Page.javascriptDialogOpening", (params) => {
      for (const listener of messageListeners) listener({}, "Page.javascriptDialogOpening", params);
    });
    opened.on("Page.screencastFrame", (params) => {
      for (const listener of messageListeners) listener({}, "Page.screencastFrame", params);
    });
    session = opened;
    return opened;
  };
  // Electron answers no dialog by itself here; leave each one to the host's
  // protocol session, as the app's own view would.
  page.on("dialog", () => undefined);
  const webContentsId = Math.floor(Math.random() * 1_000_000);
  let willDownload:
    | ((event: { preventDefault?: () => void }, item: unknown, contents: { id: number }) => void)
    | undefined;
  // Electron's session reports a download as an item the host gives a save
  // path; here the page's own download is the item, and the real bytes are
  // copied to that path once it finishes.
  page.on("download", (download) => {
    let prevented = false;
    const item = Object.assign(new EventEmitter(), {
      savePath: undefined as string | undefined,
      getFilename: () => download.suggestedFilename(),
      getTotalBytes: () => 0,
      getReceivedBytes: () => 0,
      setSavePath(path: string) {
        item.savePath = path;
      },
      cancel: () => void download.cancel(),
    });
    willDownload?.({ preventDefault: () => (prevented = true) }, item, { id: webContentsId });
    if (prevented || item.savePath === undefined) {
      void download.cancel();
      return;
    }
    const target = item.savePath;
    void download
      .saveAs(target)
      .then(() => item.emit("done", {}, "completed"))
      .catch(() => item.emit("done", {}, "interrupted"));
  });
  const refreshTitle = async () => {
    title = await page.evaluate(() => document.title).catch(() => title);
  };
  const view: BrowserSurfaceViewPort = {
    setBounds: () => undefined,
    setVisible: () => undefined,
    webContents: {
      id: webContentsId,
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
        sendCommand: async (method, parameters, sessionId) => {
          if (sessionId !== undefined) {
            const child = frameSessions.get(sessionId);
            if (child === undefined) throw new Error("No such frame session.");
            return child.send(method as "Runtime.evaluate", parameters as never);
          }
          if (method === "Target.setAutoAttach") {
            for (const frame of page.frames()) {
              if (frame === page.mainFrame()) continue;
              // Only a frame in its own process has a session of its own.
              const child = await page
                .context()
                .newCDPSession(frame)
                .catch(() => undefined);
              if (child === undefined) continue;
              const { targetInfo } = await child.send("Target.getTargetInfo");
              const id = `frame-${String(frameSessions.size + 1)}`;
              frameSessions.set(id, child);
              for (const listener of messageListeners) {
                listener({}, "Target.attachedToTarget", { sessionId: id, targetInfo }, undefined);
              }
            }
            return {};
          }
          const answer = await (
            await openSession()
          ).send(method as "Runtime.evaluate", parameters as never);
          await refreshTitle();
          return answer;
        },
        on: (_event, listener) => void messageListeners.add(listener),
        removeListener: (_event, listener) => void messageListeners.delete(listener),
      },
      // Electron's device emulation lives in the view, not in the debugger
      // session, so it has a session of its own that the host's debugger
      // attach and detach never touch.
      enableDeviceEmulation: (parameters) => {
        deviceChange = (async () => {
          await (
            await deviceSession()
          ).send("Emulation.setDeviceMetricsOverride", {
            width: parameters.viewSize.width,
            height: parameters.viewSize.height,
            deviceScaleFactor: parameters.deviceScaleFactor,
            mobile: parameters.screenPosition === "mobile",
          });
        })();
      },
      disableDeviceEmulation: () => {
        deviceChange = (async () => {
          await (await deviceSession()).send("Emulation.clearDeviceMetricsOverride");
          // Playwright sends nothing for a size it already holds.
          await page.setViewportSize({ width: 1280, height: 721 });
          await page.setViewportSize({ width: 1280, height: 720 });
        })();
      },
      executeJavaScriptInIsolatedWorld: async (_world, scripts) => {
        await deviceChange;
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
            executeJavaScript: async (code: string) => {
              await deviceChange;
              return frame.evaluate(code);
            },
          }));
        },
      },
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
        goBack: () => undefined,
        goForward: () => undefined,
      },
      on: (event: string, listener: (event: unknown, input: unknown) => void) => {
        if (event === "before-input-event") inputListeners.add(listener);
      },
      reload: () => undefined,
      session: {
        on: (_event: string, listener: never) => {
          willDownload = listener;
        },
        setDevicePermissionHandler: () => undefined,
        setDisplayMediaRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
        setPermissionRequestHandler: () => undefined,
      },
      setWindowOpenHandler: () => undefined,
      stop: () => undefined,
    },
  };
  return {
    view,
    page,
    personKey: () => {
      for (const listener of inputListeners) {
        listener({ preventDefault: () => undefined }, { type: "keyDown", key: "a" });
      }
    },
  };
}

async function surface(
  path: string,
  views = 1,
  profile?: { readonly kind: "personal" },
  downloadRoot?: string,
) {
  const pool = await Promise.all(Array.from({ length: views }, () => pageView()));
  const page = pool[0]?.page;
  const view = pool[0]?.view;
  if (page === undefined || view === undefined) throw new Error("No page.");
  let next = 0;
  const host = createBrowserSurfaceHost({
    ...(downloadRoot === undefined ? {} : { downloadRoot }),
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
      ...(profile === undefined ? {} : { profile }),
    },
  });
  const opened = await host.act(contextId, {
    kind: "navigate",
    target: `${origin}${path}`,
  });
  return {
    host,
    contextId,
    page,
    opened,
    view,
    personKey: pool[0]?.personKey ?? (() => undefined),
  };
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

/**
 * The colour of each animation frame's top-left pixel. Whatever filter a row
 * uses, the first pixel of the first row is stored as it is, so inflating a
 * frame's data is enough to read it.
 */
function apngCorners(dataUrl: string): ReadonlyArray<readonly [number, number, number]> {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  const frames: Buffer[][] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "fcTL") frames.push([]);
    if (type === "IDAT") frames.at(-1)?.push(data);
    if (type === "fdAT") frames.at(-1)?.push(data.subarray(4));
    offset += 12 + length;
  }
  return frames.map((parts) => {
    const pixels = inflateSync(Buffer.concat(parts));
    return [pixels[1] ?? 0, pixels[2] ?? 0, pixels[3] ?? 0] as const;
  });
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
    it("fills only the reviewed top document's login fields and requires a separate submit without hiding page callbacks", async () => {
      const { page, view } = await pageView();
      const site = "https://login.fixture.test";
      const owner = { windowId: "window-fill", threadId: crypto.randomUUID() };
      const contextId = crypto.randomUUID();
      const host = createBrowserSurfaceHost({ createView: () => view });
      try {
        await page.route(`${site}/**`, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><form method="post" action="/session"><label>Email<input name="email" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form><p id="reflection"></p><script>document.querySelector('input[type=password]').addEventListener('input', event => { document.getElementById('reflection').textContent = event.target.value; }); document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); document.title = 'MFA required'; });</script>`,
          }),
        );
        await page.goto(site);
        const protocol = view.webContents.debugger;
        protocol.attach("1.3");
        view.webContents.executeJavaScriptInIsolatedWorld = async (_world, scripts) => {
          const tree = (await protocol.sendCommand("Page.getFrameTree")) as {
            frameTree: { frame: { id: string } };
          };
          const world = (await protocol.sendCommand("Page.createIsolatedWorld", {
            frameId: tree.frameTree.frame.id,
            worldName: "octant-login-fixture",
          })) as { executionContextId: number };
          const result = (await protocol.sendCommand("Runtime.evaluate", {
            contextId: world.executionContextId,
            expression: scripts[0]?.code,
            returnByValue: true,
            awaitPromise: true,
          })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
          if (result.exceptionDetails !== undefined)
            throw new Error("Fixture isolated operation failed.");
          return result.result?.value;
        };
        await host.createContext({
          contextId,
          owner,
          policy: {
            profileMode: "isolated",
            profile: { kind: "private" },
            allowedOrigins: [site],
            credentialFieldProtection: true,
            maxConcurrentTabs: 1,
            sessionTimeoutMs: 300_000,
          },
        });
        const plan = await host.prepareCredentialFill(contextId, owner, site);
        expect(plan.status).toBe("prepared");
        if (plan.status !== "prepared") throw new Error("Expected login form");
        expect(await host.reserveCredentialFill(contextId, owner, plan.planId, [site])).toEqual({
          status: "reserved",
        });
        await expect(host.act(contextId, { kind: "snapshot" })).rejects.toThrow(
          /credential fill holds observations/,
        );
        expect(
          await host.commitCredentialFill(contextId, owner, plan.planId, {
            username: "fixture-user",
            password: "fixture-private",
          }),
        ).toEqual({ status: "filled", effect: "completed" });
        expect(await page.locator("input[name=email]").inputValue()).toBe("fixture-user");
        expect(await page.locator("input[type=password]").inputValue()).toBe("fixture-private");
        expect(await page.locator("#reflection").textContent()).toBe("fixture-private");
        expect(await page.evaluate(() => "octantLoginPlans" in globalThis)).toBe(false);
        expect(await page.title()).not.toBe("MFA required");
        expect(
          await host.submitCredentialFill(
            contextId,
            owner,
            plan.planId,
            new Date(Date.now() + 180_000).toISOString(),
          ),
        ).toEqual({
          status: "authentication-required",
          effect: "completed",
        });
        expect(await page.title()).toBe("MFA required");
        expect(
          await host.submitCredentialFill(
            contextId,
            owner,
            plan.planId,
            new Date(Date.now() + 180_000).toISOString(),
          ),
        ).toEqual({
          status: "authentication-required",
          effect: "completed",
        });
        const changed = await host.prepareCredentialFill(contextId, owner, site);
        if (changed.status !== "prepared") throw new Error("Expected second form review");
        await page
          .locator("input[type=password]")
          .evaluate((input) => input.setAttribute("autocomplete", "new-password"));
        expect(await host.reserveCredentialFill(contextId, owner, changed.planId, [site])).toEqual({
          status: "refused",
        });
        expect(
          await host.commitCredentialFill(contextId, owner, changed.planId, {
            username: "never",
            password: "never",
          }),
        ).toEqual({ status: "cancelled", effect: "none" });
      } finally {
        await host.closeAll();
        await page.context().close();
      }
    });

    it("observes a fresh editable incarnation after A to B to A without exporting field contents", async () => {
      const { view, page } = await pageView();
      try {
        await page.addInitScript(
          `globalThis.octantBrowserEditable = (${observeBrowserEditableTarget.toString()})();`,
        );
        await page.goto(origin + "/ime-editors");
        const read = () =>
          readBrowserEditableTarget(view.webContents.executeJavaScriptInIsolatedWorld);
        const readAvailable = async () => {
          let observed: Awaited<ReturnType<typeof read>>;
          // Each sample still fails closed at the production deadline. Like the
          // viewer, retry transient unavailability on a busy protocol transport.
          await expect
            .poll(async () => (observed = await read()), { timeout: 5_000 })
            .toBeDefined();
          return observed;
        };
        await page.locator("#a").focus();
        const first = await readAvailable();
        expect(first).toBeDefined();
        expect(JSON.stringify(first)).not.toContain("private-fixture");
        await page.locator("#b").focus();
        await page.locator("#a").focus();
        const next = await readAvailable();
        expect(next?.id).not.toBe(first?.id);
        for (const selector of ["#password", "#custom", "#readonly"]) {
          await page.locator(selector).focus();
          expect(await read()).toBeUndefined();
        }
        expect(observeBrowserEditableTarget.toString()).not.toMatch(
          /\.value\b|textContent|innerText/,
        );
        await page.evaluate(() => {
          document.open();
          document.write('<input id="a">');
          document.close();
        });
        await page.locator("#a").focus();
        expect(await read()).toBeUndefined();
      } finally {
        await page.close();
      }
    });

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

    it("reads and acts inside a frame on this site, a frame on another site, and an open shadow root", async () => {
      const { host, contextId, page } = await surface("/framed");
      await page.waitForFunction(() => document.querySelectorAll("iframe").length === 2);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const observed = await host.act(contextId, { kind: "snapshot" });
      expect(observed.snapshot).toMatch(/^- iframe "Search"$/m);
      expect(observed.snapshot).toMatch(/^ {2}- textbox "Query" \[ref=e\d+\]$/m);
      expect(observed.snapshot).toMatch(/^- iframe "Elsewhere"$/m);
      expect(observed.snapshot).toMatch(/^ {2}- button "Remote find" \[ref=e\d+\]$/m);
      expect(observed.snapshot).toMatch(/- button "Shadow save" \[ref=e\d+\]/);
      const act = (kind: "click" | "type", name: string, value?: string) => {
        const found = entry(observed.snapshotRefs, name);
        return host.act(contextId, {
          kind,
          target: found.selector,
          ...(value === undefined ? {} : { value }),
          expected: { role: found.role, name: found.name, url: `${origin}/framed` },
        });
      };
      await act("type", "Query", "Ada");
      expect((await act("click", "Find")).title).toBe("Found Ada");
      await act("type", "Remote query", "Grace");
      await act("click", "Remote find");
      await page.waitForFunction(() => document.title === "Remote Grace");
      expect((await act("click", "Shadow save")).title).toBe("Shadow saved");
      expect((await act("click", "Deep save")).title).toBe("Deep saved");
      await page.close();
    });

    it("protects a credential field in a frame on another site and withholds every value", async () => {
      const { host, contextId, page } = await surface("/framed-login");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const observed = await host.act(contextId, { kind: "snapshot" });
      expect(observed.snapshot).toMatch(/^ {2}- textbox "Password" \[ref=e\d+\] protected$/m);
      expect(observed.snapshot).not.toContain("hunter2");
      expect(observed.snapshot).not.toContain("ada@example.com");
      const password = entry(observed.snapshotRefs, "Password");
      await expect(
        host.act(contextId, { kind: "type", target: password.selector, value: "guess" }),
      ).rejects.toThrow(/credential field/);
      expect((await host.inspectTarget(contextId, password.selector)).sensitive).toBe(true);
      await page.close();
    });

    it("leaves out a frame on another site from a signed-in page", async () => {
      const { host, contextId, page } = await surface("/framed", 1, { kind: "personal" });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const observed = await host.act(contextId, { kind: "snapshot" });
      expect(observed.snapshot).toMatch(/^ {2}- textbox "Query" \[ref=e\d+\]$/m);
      expect(observed.snapshot).toMatch(/^- iframe "http:\/\/localhost:\d+" not included$/m);
      expect(observed.snapshot).not.toContain("Remote find");
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

    it("holds an agent key or click once the person has typed, and frees it after a snapshot, keeping their text", async () => {
      const { host, contextId, page, personKey } = await surface("/form");
      const before = await host.act(contextId, { kind: "snapshot" });
      const name = entry(before.snapshotRefs, "Name");
      await page.fill("#name", "Grace");
      personKey();
      await expect(
        host.act(contextId, { kind: "type", target: name.selector, value: "Ada" }),
      ).rejects.toBeInstanceOf(BrowserTargetStaleError);
      expect(await page.inputValue("#name")).toBe("Grace");
      // Reading is allowed, and a snapshot makes the page actable again.
      await host.act(contextId, { kind: "extract-text" });
      await host.act(contextId, { kind: "snapshot" });
      await host.act(contextId, { kind: "type", target: "#name", value: "Ada" });
      expect(await page.inputValue("#name")).toContain("Ada");
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

    it("records the agent's actions as an animated PNG and lets the debugger go when the recording ends", async () => {
      const { host, contextId, page, view } = await surface("/controls");
      await host.act(contextId, { kind: "record-start" });
      // The recording holds the attachment between actions, as an emulation does.
      expect(view.webContents.debugger.isAttached()).toBe(true);
      await host.act(contextId, { kind: "select", target: "#size", value: "l" });
      await host.act(contextId, { kind: "hover", target: "#menu" });
      const stopped = await host.act(contextId, { kind: "record-stop" });
      expect(view.webContents.debugger.isAttached()).toBe(false);
      const recording = stopped.recording;
      if (recording?.status !== "recorded") throw new Error(`not recorded: ${recording?.status}`);
      expect(recording.frames).toBeGreaterThanOrEqual(1);
      const bytes = Buffer.from(recording.dataUrl.split(",")[1] ?? "", "base64");
      const actl = bytes.indexOf("acTL");
      expect(actl).toBeGreaterThan(0);
      expect(bytes.readUInt32BE(actl + 4)).toBe(recording.frames);
      expect(Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20))).toBeLessThanOrEqual(800);
      // A stop with nothing running is empty, not an error.
      expect((await host.act(contextId, { kind: "record-stop" })).recording).toEqual({
        status: "empty",
      });
      await page.close();
    });

    it("keeps no frame of a page the person took to a site the thread did not approve", async () => {
      const { host, contextId, page } = await surface("/red");
      const other = `http://localhost:${String((server.address() as AddressInfo).port)}`;
      await host.act(contextId, { kind: "record-start" });
      await page.waitForTimeout(600);
      // The person takes the agent's own view to another site and back.
      await page.goto(`${other}/blue`);
      await page.waitForTimeout(900);
      await page.goto(`${origin}/red`);
      await page.waitForTimeout(600);
      const stopped = await host.act(contextId, { kind: "record-stop" });
      const recording = stopped.recording;
      if (recording?.status !== "recorded") throw new Error(`not recorded: ${recording?.status}`);
      const corners = apngCorners(recording.dataUrl);
      expect(corners.length).toBe(recording.frames);
      expect(corners.some(([red, , blue]) => red > 180 && blue < 80)).toBe(true);
      expect(corners.filter(([red, , blue]) => blue > 180 && red < 80)).toEqual([]);
      await page.close();
    });

    it("ends a recording when another tab comes to the front, under the recorded tab's address", async () => {
      const { host, contextId, page, view } = await surface("/red", 2);
      await host.act(contextId, { kind: "record-start" });
      await page.waitForTimeout(600);
      await host.act(contextId, { kind: "tab-open", target: `${origin}/blue` });
      await page.waitForTimeout(600);
      const stopped = await host.act(contextId, { kind: "record-stop", include: ["text"] });
      // The observation is of the tab in front; the recording is of the one it started on.
      expect(stopped.url).toBe(`${origin}/blue`);
      const recording = stopped.recording;
      if (recording?.status !== "recorded") throw new Error(`not recorded: ${recording?.status}`);
      expect(recording).toMatchObject({
        truncated: "tab-changed",
        url: `${origin}/red`,
        title: "Red",
      });
      const corners = apngCorners(recording.dataUrl);
      expect(corners.filter(([red, , blue]) => blue > 180 && red < 80)).toEqual([]);
      expect(view.webContents.debugger.isAttached()).toBe(false);
      await page.close();
    });

    it("withholds a recording of a page that holds a credential field", async () => {
      const { host, contextId, page } = await surface("/login");
      await host.act(contextId, { kind: "record-start" });
      await host.act(contextId, { kind: "hover", target: "button" });
      const stopped = await host.act(contextId, { kind: "record-stop" });
      expect(stopped.recording).toEqual({ status: "withheld" });
      await page.close();
    });

    it("emulates a phone, touch, and a color scheme on the agent's view and restores all three", async () => {
      const { host, contextId, page } = await surface("/device");
      // The page's color scheme follows the machine, so it is read, not assumed.
      const baseline = (await host.act(contextId, { kind: "resize" })).emulation;
      expect(baseline).toMatchObject({ width: 1280, touch: false });
      const phone = await host.act(contextId, {
        kind: "resize",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        mobile: true,
        touch: true,
        colorScheme: "dark",
      });
      expect(phone.emulation).toEqual({
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        touch: true,
        colorScheme: "dark",
      });
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(
        true,
      );
      // The touch and color scheme outlive the action's own debugger attach.
      const tapped = await host.act(contextId, {
        kind: "click",
        target: "#tap",
        include: ["text"],
      });
      expect(tapped.extractedText).toMatch(/touchstart click/);
      expect(tapped.emulation).toBeUndefined();
      const light = await host.act(contextId, {
        kind: "resize",
        colorScheme: "light",
      });
      expect(light.emulation).toMatchObject({
        width: 390,
        touch: true,
        colorScheme: "light",
      });
      const restored = await host.act(contextId, { kind: "resize" });
      expect(restored.emulation).toEqual(baseline);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
      await page.close();
    });

    it("audits a page's accessibility with the fixed reader, finding each planted problem and no clean element", async () => {
      const { host, contextId, page } = await surface("/audit");
      const read = async () => {
        const observed = await host.act(contextId, { kind: "audit", auditKind: "accessibility" });
        if (observed.audit?.kind !== "accessibility") throw new Error("No accessibility audit.");
        return { observed, reading: observed.audit.reading };
      };
      const { observed, reading } = await read();
      expect(observed.url).toBe(`${origin}/audit`);
      const count = (rule: string) => reading.found.find((entry) => entry.rule === rule)?.count;
      expect(Object.fromEntries(reading.found.map((entry) => [entry.rule, entry.count]))).toEqual({
        "image-alt": 1,
        "button-name": 3,
        "link-name": 1,
        "field-name": 1,
        "heading-order": 1,
        "document-lang": 1,
        "duplicate-id-aria": 1,
        "focusable-hidden": 1,
        "color-contrast": 1,
      });
      const finding = (rule: string) => reading.findings.find((each) => each.rule === rule);
      expect(finding("image-alt")?.selector).toBe("#bare");
      // Text hidden inside a button names nothing; a hidden labelledby target does.
      expect(
        reading.findings.filter((each) => each.rule === "button-name").map((each) => each.selector),
      ).toEqual(["#icon", "#ghost", "#muted"]);
      expect(finding("link-name")?.selector).toBe("#empty");
      expect(finding("field-name")?.selector).toBe("#unlabelled");
      expect(finding("heading-order")?.detail).toEqual({ level: 3, previousLevel: 1 });
      expect(finding("duplicate-id-aria")?.detail).toEqual({ id: "hint", count: 2 });
      expect(finding("focusable-hidden")?.name).toBe("Hidden link");
      expect(finding("color-contrast")).toMatchObject({
        text: "Faint words",
        detail: { ratio: 2.32, required: 4.5, foreground: "#aaaaaa", background: "#ffffff" },
      });
      // The gradient, and the text inside a nearly transparent container.
      expect(reading.contrastNotMeasured).toBe(2);
      expect(reading.frames).toBe(1);
      expect(reading.touch).toBe(false);
      expect(count("target-size")).toBeUndefined();
      // On a touch device the crowded small buttons are found as well.
      await host.act(contextId, {
        kind: "resize",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        mobile: true,
        touch: true,
      });
      const touched = await read();
      expect(touched.reading.touch).toBe(true);
      expect(
        touched.reading.findings
          .filter((each) => each.rule === "target-size")
          .map((each) => each.selector),
      ).toEqual(expect.arrayContaining(["#tiny-a", "#tiny-b"]));
      await host.act(contextId, { kind: "resize" });
      await page.close();
    });

    it("withholds the text typed into an editable field from findings, and judges slotted text against the slot's backdrop", async () => {
      const { host, contextId, page } = await surface("/audit-private");
      const observed = await host.act(contextId, { kind: "audit", auditKind: "accessibility" });
      if (observed.audit?.kind !== "accessibility") throw new Error("No accessibility audit.");
      const { reading } = observed.audit;
      const written = JSON.stringify(reading.findings);
      expect(written).not.toContain("secret");
      expect(written).not.toContain("Typed heading");
      expect(written).not.toContain("typed name");
      expect(
        reading.findings.filter((each) => each.rule === "color-contrast").map((each) => each.text),
      ).toEqual([undefined, "Slotted words"]);
      expect(reading.findings.find((each) => each.text === "Slotted words")?.detail).toMatchObject({
        foreground: "#555555",
        background: "#000000",
      });
      // A label taken from typed text is skipped; the link's own text names it.
      expect(reading.findings.find((each) => each.rule === "focusable-hidden")?.name).toBe(
        "Hidden link",
      );
      expect(reading.findings.find((each) => each.rule === "heading-order")).toMatchObject({
        role: "heading",
        detail: { level: 3, previousLevel: 1 },
      });
      // The text drawn through the half-transparent slot.
      expect(reading.contrastNotMeasured).toBe(1);
      await page.close();
    });

    it("reads a shadow root's slotted heading where the slot draws it, and judges a host's text in the slot's colours", async () => {
      const { host, contextId, page } = await surface("/audit-slots");
      const observed = await host.act(contextId, { kind: "audit", auditKind: "accessibility" });
      if (observed.audit?.kind !== "accessibility") throw new Error("No accessibility audit.");
      const { reading } = observed.audit;
      // h1, then the slotted h2, then the shadow root's h3: no level is skipped.
      expect(reading.findings.filter((each) => each.rule === "heading-order")).toEqual([]);
      expect(reading.findings.filter((each) => each.rule === "color-contrast")).toEqual([
        expect.objectContaining({
          text: "Host words",
          detail: expect.objectContaining({ foreground: "#555555", background: "#000000" }),
        }),
      ]);
      expect(reading.truncated).toBe(false);
      await page.close();
    });

    it("checks the spacing of every touch target the audit reads, past the first thousand", async () => {
      const { host, contextId, page } = await surface("/audit-targets");
      await host.act(contextId, {
        kind: "resize",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        mobile: true,
        touch: true,
      });
      const observed = await host.act(contextId, { kind: "audit", auditKind: "accessibility" });
      if (observed.audit?.kind !== "accessibility") throw new Error("No accessibility audit.");
      const { reading } = observed.audit;
      expect(reading.touch).toBe(true);
      expect(reading.truncated).toBe(false);
      expect(
        reading.findings.filter((each) => each.rule === "target-size").map((each) => each.selector),
      ).toEqual(["#late-a", "#late-b"]);
      await host.act(contextId, { kind: "resize" });
      await page.close();
    });

    it("finds an unnamed control exactly where the browser computes no accessible name", async () => {
      const { host, contextId, page } = await surface("/audit-names");
      const observed = await host.act(contextId, { kind: "audit", auditKind: "accessibility" });
      if (observed.audit?.kind !== "accessibility") throw new Error("No accessibility audit.");
      const naming = new Set(["button-name", "link-name", "field-name", "image-alt"]);
      const flagged = observed.audit.reading.findings
        .filter((each) => naming.has(each.rule))
        .map((each) => each.selector.replace(/^#/, ""));
      const cdp = await page.context().newCDPSession(page);
      const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
      const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "[data-control]",
      });
      const unnamed: string[] = [];
      for (const nodeId of nodeIds) {
        const { node } = await cdp.send("DOM.describeNode", { nodeId });
        const id = node.attributes?.[(node.attributes?.indexOf("id") ?? 0) + 1] ?? "";
        const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
          nodeId,
          fetchRelatives: false,
        });
        const name: unknown = nodes[0]?.name?.value;
        if (typeof name !== "string" || name.trim() === "") unnamed.push(id);
      }
      await cdp.detach();
      // The browser's own "Submit" for an image button and "Choose File" for a
      // file field name the action, not the image or the field, so the audit
      // still asks the author for one.
      expect(flagged.toSorted()).toEqual([...unnamed, "img", "file"].toSorted());
      expect(unnamed.toSorted()).toEqual(
        [
          "sube",
          "subs",
          "rese",
          "btn",
          "b",
          "sum",
          "im",
          "sel",
          "selp",
          "ta",
          "txt",
          "lb",
          "al",
          "chk",
          "a",
        ].toSorted(),
      );
      await page.close();
    });

    it("measures text only against a background the browser paints, and counts the rest as not measured", async () => {
      const { host, contextId, page } = await surface("/audit-paint");
      const observed = await host.act(contextId, { kind: "audit", auditKind: "accessibility" });
      if (observed.audit?.kind !== "accessibility") throw new Error("No accessibility audit.");
      const { reading } = observed.audit;
      // A `display: contents` or hidden wrapper paints nothing behind the readable text.
      expect(reading.findings.filter((each) => each.rule === "color-contrast")).toEqual([]);
      // The gradient, the clipped, pseudo-element, backdrop-filtered, masked,
      // blended, and filtered text.
      expect(reading.contrastNotMeasured).toBe(7);
      await page.close();
    });

    it("audits only the elements it reads on a page larger than its bound", async () => {
      const { host, contextId, page } = await surface("/audit-large");
      const observed = await host.act(contextId, { kind: "audit", auditKind: "accessibility" });
      if (observed.audit?.kind !== "accessibility") throw new Error("No accessibility audit.");
      expect(observed.audit.reading.truncated).toBe(true);
      expect(observed.audit.reading.found).toEqual([]);
      await page.close();
    });

    it("audits a page's load from the browser's own record without reloading it", async () => {
      const { host, contextId, page, view } = await surface("/perf");
      await page.waitForFunction(() => document.getElementById("above")?.style.height === "120px");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const marker = await page.evaluate(() => {
        Reflect.set(window, "auditMarker", "kept");
        return performance.timeOrigin;
      });
      const observed = await host.act(contextId, { kind: "audit", auditKind: "performance" });
      if (observed.audit?.kind !== "performance") throw new Error("No performance audit.");
      const { reading, counters } = observed.audit;
      expect(reading.navigation?.responseStart).toBeGreaterThan(0);
      expect(reading.firstContentfulPaint).toBeGreaterThan(0);
      expect(reading.largestContentfulPaint?.startTime).toBeGreaterThan(0);
      expect(reading.longTasks?.some((task) => task.duration >= 150)).toBe(true);
      expect(reading.layoutShifts?.some((shift) => shift.value > 0)).toBe(true);
      expect(reading.resources.map((resource) => resource.url)).toContain(
        `${origin}/pixel.svg?token=s3cret`,
      );
      expect(counters).toMatchObject({ status: "read", domNodes: expect.any(Number) });
      // The same document: nothing navigated or reloaded it.
      expect(
        await page.evaluate(() => [Reflect.get(window, "auditMarker"), performance.timeOrigin]),
      ).toEqual(["kept", marker]);
      // Someone else's developer tools: the timeline is still read, the counters are not.
      view.webContents.debugger.attach("1.3");
      const held = await host.act(contextId, { kind: "audit", auditKind: "performance" });
      expect(held.audit).toMatchObject({
        kind: "performance",
        counters: { status: "unavailable" },
        reading: { firstContentfulPaint: expect.any(Number) },
      });
      expect(view.webContents.debugger.isAttached()).toBe(true);
      await page.close();
    });

    it("forgets touch the page lost when its debugger attachment was dropped", async () => {
      const { host, contextId, page, view } = await surface("/device");
      await host.act(contextId, { kind: "resize", touch: true });
      // Developer tools opening on the view replace the agent's attachment.
      view.webContents.debugger.detach();
      // This stand-in ends the protocol session asynchronously; Electron's is immediate.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const clicked = await host.act(contextId, {
        kind: "click",
        target: "#tap",
        include: ["text"],
      });
      expect(clicked.extractedText).toMatch(/click/);
      expect(clicked.extractedText).not.toMatch(/touchstart/);
      const again = await host.act(contextId, { kind: "resize", touch: true });
      expect(again.emulation).toMatchObject({ touch: true });
      await host.act(contextId, { kind: "resize" });
      expect(view.webContents.debugger.isAttached()).toBe(false);
      await page.close();
    });

    it("leaves device emulation alone when someone else's developer tools hold the page", async () => {
      const { host, contextId, page, view } = await surface("/device");
      // Someone else's debugger: attached before the agent's action begins.
      view.webContents.debugger.attach("1.3");
      await expect(host.act(contextId, { kind: "resize", touch: true })).rejects.toThrow(
        /already in use/,
      );
      await expect(host.act(contextId, { kind: "resize", colorScheme: "dark" })).rejects.toThrow(
        /already in use/,
      );
      expect(view.webContents.debugger.isAttached()).toBe(true);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
      // A size needs no debugger, so it still applies.
      const sized = await host.act(contextId, {
        kind: "resize",
        viewport: { width: 600, height: 800 },
      });
      expect(sized.emulation).toMatchObject({ width: 600 });
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

    describe("downloads", () => {
      it("blocks a download the page starts unless an agent action holds it", async () => {
        const root = await mkdtemp(join(tmpdir(), "octant-desktop-downloads-"));
        const { host, contextId, page } = await surface("/downloads", 1, undefined, root);
        const observed = await host.act(contextId, { kind: "snapshot" });
        const report = entry(observed.snapshotRefs, "Report");
        // Without "hold", as when the switch is off or the person drives: blocked.
        const blocked = await host.act(contextId, { kind: "click", target: report.selector });
        expect(blocked.downloads).toBeUndefined();
        // After the action ended, the page starting one is blocked as well.
        await page.evaluate(() => document.getElementById("report")?.click());
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(host.claimDownload(contextId, "d1")).toBeUndefined();
        await page.close();
        await rm(root, { recursive: true, force: true });
      });

      it("holds a download during an agent action, with its real bytes, and discards it", async () => {
        const root = await mkdtemp(join(tmpdir(), "octant-desktop-downloads-"));
        const { host, contextId, page } = await surface("/downloads", 1, undefined, root);
        const observed = await host.act(contextId, { kind: "snapshot" });
        const clicked = await host.act(contextId, {
          kind: "click",
          target: entry(observed.snapshotRefs, "Report").selector,
          downloads: "hold",
        });
        expect(clicked.downloads).toEqual([
          {
            state: "held",
            downloadId: "d1",
            name: "report.pdf",
            sizeBytes: PDF_BYTES.length,
            mediaType: "application/pdf",
          },
        ]);
        const path = host.claimDownload(contextId, "d1");
        expect(path?.startsWith(root)).toBe(true);
        expect(readFileSync(path ?? "")).toEqual(PDF_BYTES);
        // Reported once.
        const next = await host.act(contextId, { kind: "extract-text" });
        expect(next.downloads).toBeUndefined();
        await host.discardDownload(contextId, "d1");
        expect(existsSync(path ?? "")).toBe(false);
        expect(host.claimDownload(contextId, "d1")).toBeUndefined();
        await page.close();
        await rm(root, { recursive: true, force: true });
      });

      it("deletes what a context holds when it closes", async () => {
        const root = await mkdtemp(join(tmpdir(), "octant-desktop-downloads-"));
        const { host, contextId, page } = await surface("/downloads", 1, undefined, root);
        const observed = await host.act(contextId, { kind: "snapshot" });
        await host.act(contextId, {
          kind: "click",
          target: entry(observed.snapshotRefs, "Notes").selector,
          downloads: "hold",
        });
        const path = host.claimDownload(contextId, "d1");
        expect(existsSync(path ?? "")).toBe(true);
        await host.closeAll();
        expect(existsSync(path ?? "")).toBe(false);
        await page.close().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      });
    });
  },
);
