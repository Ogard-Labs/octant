import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserThreadId, ToolActionAuthority, WindowId } from "@octant/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserAppManagedTools } from "./browserAppManagedTools";
import { BrowserAutomationService } from "./browserAutomationService";
import { createPlaywrightBrowserRuntime } from "./playwrightBrowserRuntime";

/**
 * The agent's Browser tool, end to end: the tool executor, the server's
 * service, and a real headless Chromium on a page served from this process.
 * Skipped where no Chromium is installed.
 */

const pages: Record<string, string> = {
  "/login": `<!doctype html><title>Sign in</title>
    <h1>Sign in</h1>
    <form id="f">
      <label for="user">Email</label><input id="user" name="user" value="ada@example.com">
      <label for="pass">Password</label><input id="pass" type="password" value="hunter2">
      <button type="submit">Continue</button>
    </form>
    <script>document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); document.title = "Submitted"; });</script>`,
  "/form": `<!doctype html><title>Form</title>
    <h1>Order</h1>
    <p>Pick a size and press Save.</p>
    <label>Name <input id="name"></label>
    <label><input type="checkbox" id="gift" checked> Gift wrap</label>
    <button id="save" onclick="document.title = 'Saved ' + document.getElementById('name').value">Save</button>
    <button id="rename" onclick="document.getElementById('save').textContent = 'Store'">Rename save</button>
    <a href="/other">Elsewhere</a>`,
  "/hidden-credential": `<!doctype html><title>Keys</title>
    <label for="mail">Email</label><input id="mail" value="ada@example.com">
    <div contenteditable id="token">sk-live-abc</div>
    <label>API key<textarea name="token">sk-live-secret</textarea></label>
    <div id="host"></div>
    <script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<input type="password" value="hunter2">';</script>`,
  "/moves-on": `<!doctype html><title>Moves on</title><button id="save">Save</button>
    <script>setTimeout(() => { location.href = "/moved"; }, 300);</script>`,
  "/moved": `<!doctype html><title>Moved</title><button id="save">Save</button>`,
  "/controls": `<!doctype html><title>Controls</title>
    <nav id="menu" onmouseenter="document.getElementById('item').hidden = false">Menu
      <a id="item" href="/other" hidden>Open settings</a></nav>
    <label for="size">Size</label>
    <select id="size" onchange="document.title = 'Size ' + this.value">
      <option value="s">Small</option><option value="l">Large</option>
    </select>
    <div id="card" draggable="true" ondragstart="event.dataTransfer.setData('text', 'card')">Card</div>
    <div id="done" ondragover="event.preventDefault()" ondrop="event.preventDefault(); document.title = 'Dropped ' + event.dataTransfer.getData('text')">Done</div>
    <input id="keys" aria-label="Keys" onkeydown="if (event.ctrlKey) document.title = 'Chord ' + event.key">
    <label for="file">Attachment</label>
    <input id="file" type="file" onchange="document.title = 'Attached ' + this.files[0].name + ' ' + this.files[0].size">
    <button id="read" onclick="document.getElementById('file').files[0].text().then((text) => { document.title = 'Read ' + text; })">Read</button>`,
  "/later-leave": `<!doctype html><title>Later</title>
    <script>setTimeout(() => { location.href = "/leave"; }, 100);</script>`,
  "/other": `<!doctype html><title>Other</title><button>Save</button>`,
};

const threadId = randomUUID() as BrowserThreadId;
const windowId = randomUUID() as WindowId;
const authority = {
  hostId: randomUUID(),
  mode: "work",
  projectId: randomUUID(),
  rootId: randomUUID(),
  providerInstanceId: randomUUID(),
  extension: { kind: "core" },
} as unknown as ToolActionAuthority;

const runtime = createPlaywrightBrowserRuntime();
const available = await runtime.available();
let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    // A page on this origin that sends the browser to another one: the same
    // server under its other name is a different origin.
    if (path === "/leave") {
      const port = (server.address() as AddressInfo).port;
      response.writeHead(302, { location: `http://localhost:${String(port)}/other` });
      response.end();
      return;
    }
    const body = pages[path];
    response.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html" });
    response.end(body ?? "missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await runtime.closeAll();
  await new Promise((resolve) => server.close(resolve));
});

function agentTool(
  options: {
    readonly uploadRoot?: string;
    readonly uploadAnswer?: "approved" | "denied";
    /** Runs while the person is being asked, before the answer. */
    readonly whileAsking?: () => Promise<void>;
  } = {},
) {
  const asked: Array<Record<string, unknown>> = [];
  const service = new BrowserAutomationService({
    runtime,
    authority: { canAccessWindow: () => true, resolve: () => authority },
    uuid: () => randomUUID(),
    clock: () => new Date().toISOString(),
    now: () => Date.now(),
  });
  const tools = createBrowserAppManagedTools({
    windowId,
    threadId,
    mode: "work",
    modelId: "model",
    resolveModelId: () => "model",
    modelBindings: new Map(),
    executionPolicy: "approval-gated",
    resolveAuthority: () => authority,
    browser: {
      inspectThread: (window, thread) => service.inspectThread(window, thread),
      create: (input) => service.create(input),
      act: (input) => service.act(input),
      releaseThread: (window, thread) => service.releaseThread(window, thread),
    },
    approvals: {
      request: async (request) => {
        asked.push(request as unknown as Record<string, unknown>);
        if (!("upload" in request)) return "approved";
        await options.whileAsking?.();
        return options.uploadAnswer ?? "approved";
      },
    },
    ...(options.uploadRoot === undefined ? {} : { uploadRoot: () => options.uploadRoot }),
    uuid: () => randomUUID(),
  });
  const call = async (input: Record<string, unknown>) => {
    const answer = await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify(input),
    });
    return answer as {
      readonly isError: boolean;
      readonly images?: ReadonlyArray<unknown>;
      readonly result: {
        readonly failure?: { readonly category: string };
        readonly page?: Record<string, unknown> & { readonly snapshot?: string };
      };
    };
  };
  return { asked, call, service, stop: () => call({ operation: "stop" }) };
}

function refFor(outline: string | undefined, line: RegExp): string {
  const match = (outline ?? "").split("\n").find((entry) => line.test(entry));
  const ref = /\[ref=(e\d+)\]/.exec(match ?? "")?.[1];
  if (ref === undefined) throw new Error(`No ref for ${String(line)} in:\n${outline ?? ""}`);
  return ref;
}

describe.skipIf(!available)("the agent's Browser tool on a real page", () => {
  it("lists a sign-in form's fields with refs, a protected password, and no values", async () => {
    const tool = agentTool();
    await tool.call({ operation: "navigate", url: `${origin}/login` });
    const answer = await tool.call({ operation: "snapshot" });
    const outline = answer.result.page?.snapshot ?? "";
    expect(answer.isError).toBe(false);
    expect(outline).toMatch(/- heading "Sign in" \[level=1\]/);
    expect(outline).toMatch(/- textbox "Email" \[ref=e\d+\]$/m);
    expect(outline).toMatch(/- textbox "Password" \[ref=e\d+\] protected$/m);
    expect(outline).toMatch(/- button "Continue" \[ref=e\d+\]/);
    expect(outline).not.toContain("hunter2");
    expect(outline).not.toContain("ada@example.com");
    const typed = await tool.call({
      operation: "type",
      ref: refFor(outline, /"Password"/),
      text: "guess",
    });
    expect(typed.result.failure?.category).toBe("credential-protected");
    await tool.stop();
  });

  it("names no editable element by what was typed into it and finds a credential in a shadow root", async () => {
    const tool = agentTool();
    await tool.call({ operation: "navigate", url: `${origin}/hidden-credential` });
    const outline = (await tool.call({ operation: "snapshot" })).result.page?.snapshot ?? "";
    expect(outline).toMatch(/- textbox "Email" \[ref=e\d+\]$/m);
    expect(outline).toMatch(/- textbox \[ref=e\d+\] protected$/m);
    expect(outline).not.toContain("sk-live-abc");
    expect(outline).toMatch(/- textbox "API key" \[ref=e\d+\] protected$/m);
    expect(outline).not.toContain("sk-live-secret");
    expect(outline).not.toContain("ada@example.com");
    await tool.stop();
  });

  it("clicks and types by ref, and shows field values on a page without credentials", async () => {
    const tool = agentTool();
    await tool.call({ operation: "navigate", url: `${origin}/form` });
    const outline = (await tool.call({ operation: "snapshot" })).result.page?.snapshot;
    expect(outline).toMatch(/- text "Pick a size and press Save\."/);
    expect(outline).toMatch(/- checkbox "Gift wrap" \[ref=e\d+\] checked/);
    const typed = await tool.call({
      operation: "type",
      ref: refFor(outline, /"Name"/),
      text: "Ada",
    });
    expect(typed.isError).toBe(false);
    const clicked = await tool.call({ operation: "click", ref: refFor(outline, /"Save"/) });
    expect(clicked.result.page?.title).toBe("Saved Ada");
    const again = (await tool.call({ operation: "snapshot" })).result.page?.snapshot;
    expect(again).toMatch(/- textbox "Name" \[ref=e\d+\] value="Ada"/);
    await tool.stop();
  });

  it("refuses a ref after the page moved on by itself, even to an element of the same name", async () => {
    const tool = agentTool();
    await tool.call({ operation: "navigate", url: `${origin}/moves-on` });
    const outline = (await tool.call({ operation: "snapshot" })).result.page?.snapshot;
    await new Promise((resolve) => setTimeout(resolve, 800));
    const clicked = await tool.call({ operation: "click", ref: refFor(outline, /"Save"/) });
    expect(clicked.result.failure?.category).toBe("stale");
    await tool.stop();
  });

  it("refuses a ref the page no longer matches, an unknown ref, and a ref from before a navigation", async () => {
    const tool = agentTool();
    await tool.call({ operation: "navigate", url: `${origin}/form` });
    const outline = (await tool.call({ operation: "snapshot" })).result.page?.snapshot;
    const save = refFor(outline, /"Save"/);
    await tool.call({ operation: "click", ref: refFor(outline, /"Rename save"/) });
    const renamed = await tool.call({ operation: "click", ref: save });
    expect(renamed).toMatchObject({ isError: true, result: { failure: { category: "stale" } } });
    const unknown = await tool.call({ operation: "click", ref: "e999" });
    expect(unknown.result.failure?.category).toBe("stale");
    const fresh = (await tool.call({ operation: "snapshot" })).result.page?.snapshot;
    const elsewhere = refFor(fresh, /link "Elsewhere"/);
    await tool.call({ operation: "navigate", url: `${origin}/other` });
    const gone = await tool.call({ operation: "click", ref: elsewhere });
    expect(gone.result.failure?.category).toBe("stale");
    await tool.stop();
  });

  it("answers an action with what changed and no page text or picture unless asked", async () => {
    const tool = agentTool();
    await tool.call({ operation: "navigate", url: `${origin}/form` });
    await tool.call({ operation: "type", selector: "#name", text: "Ada" });
    const clicked = await tool.call({ operation: "click", selector: "#save" });
    expect(clicked.result.page).toMatchObject({ changed: 'Title is now "Saved Ada".' });
    expect(clicked.images).toBeUndefined();
    expect(clicked.result.page).not.toHaveProperty("text");
    expect(clicked.result.page).not.toHaveProperty("snapshot");
    expect(clicked.result.page).not.toHaveProperty("contentHash");
    expect(tool.service.inspectThread(windowId, threadId).observation?.screenshotDataUrl).toBe(
      undefined,
    );

    const renamed = await tool.call({
      operation: "click",
      selector: "#rename",
      include: ["snapshot", "text", "screenshot"],
    });
    expect(renamed.result.page?.changed).toBe("The page's text changed.");
    expect(renamed.result.page?.snapshot).toMatch(/- button "Store" \[ref=e\d+\]/);
    expect(renamed.result.page?.text).toContain("Store");
    expect(renamed.images).toHaveLength(1);
    const store = await tool.call({
      operation: "click",
      ref: refFor(renamed.result.page?.snapshot, /"Store"/),
    });
    expect(store.isError).toBe(false);

    const read = await tool.call({ operation: "read-page" });
    expect(read.result.page).not.toHaveProperty("changed");
    await tool.stop();
  });

  it("keeps the person's activity preview picture after an action that took none", async () => {
    const tool = agentTool();
    await tool.call({ operation: "navigate", url: `${origin}/form` });
    const clicked = await tool.call({ operation: "click", selector: "#save" });
    const preview = await tool.service.peekThread(windowId, threadId);
    expect(preview.observation?.screenshotDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    // The Browser pane, which polls the context by its id, gets one too.
    const contextId = preview.context?.contextId;
    if (contextId === undefined) throw new Error("No context.");
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    const pane = await tool.service.peekContext(windowId, threadId, contextId);
    expect(pane.observation?.screenshotDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    // The preview's picture does not make the agent's next action stale.
    const next = await tool.call({
      operation: "click",
      selector: "#save",
      expectedObservationRevision: clicked.result.page?.observationRevision,
    });
    expect(next.result.page?.observationRevision).toBe(
      Number(clicked.result.page?.observationRevision) + 1,
    );
    await tool.stop();
  });

  it("hovers to open a menu, chooses an option, drags, and presses a key chord", async () => {
    const tool = agentTool();
    await tool.call({ operation: "navigate", url: `${origin}/controls` });
    const before = (await tool.call({ operation: "snapshot" })).result.page?.snapshot;
    expect(before).not.toContain("Open settings");
    const hovered = await tool.call({
      operation: "hover",
      selector: "#menu",
      include: ["snapshot"],
    });
    expect(hovered.result.page?.snapshot).toMatch(/- link "Open settings" \[ref=e\d+\]/);
    const chosen = await tool.call({
      operation: "select",
      ref: refFor(hovered.result.page?.snapshot, /combobox "Size"/),
      value: "Large",
    });
    expect(chosen.result.page?.title).toBe("Size l");
    const missing = await tool.call({ operation: "select", selector: "#size", value: "Huge" });
    expect(missing.isError).toBe(true);
    const dragged = await tool.call({ operation: "drag", selector: "#card", toSelector: "#done" });
    expect(dragged.result.page?.title).toBe("Dropped card");
    await tool.call({ operation: "click", selector: "#keys" });
    const chord = await tool.call({ operation: "press", key: "Control+B" });
    expect(chord.result.page?.title).toBe("Chord b");
    const refused = await tool.call({ operation: "press", key: "Control+Control+B" });
    expect(refused.isError).toBe(true);
    await tool.stop();
  });

  it("uploads a workspace file after asking, and refuses a link, an escape, and a refusal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "octant-upload-"));
    try {
      await writeFile(join(workspace, "notes.txt"), "hello");
      await mkdir(join(workspace, "real"));
      await writeFile(join(workspace, "real", "deep.txt"), "deep");
      await symlink(join(workspace, "notes.txt"), join(workspace, "link.txt"));
      await symlink(join(workspace, "real"), join(workspace, "linked-folder"));
      const tool = agentTool({ uploadRoot: workspace });
      await tool.call({ operation: "navigate", url: `${origin}/controls` });
      tool.asked.length = 0;
      const sent = await tool.call({
        operation: "upload",
        selector: "#file",
        files: ["notes.txt"],
      });
      expect(sent.result.page?.title).toBe("Attached notes.txt 5");
      // The page reads the file when a later action sends it.
      await tool.call({ operation: "click", selector: "#read" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const read = await tool.call({ operation: "read-page" });
      expect(read.result.page?.title).toBe("Read hello");
      expect(tool.asked).toEqual([
        expect.objectContaining({
          origin,
          upload: [expect.objectContaining({ name: "notes.txt", sizeBytes: 5 })],
        }),
      ]);
      for (const [files, reason] of [
        [["link.txt"], "upload-symlink"],
        [["linked-folder/deep.txt"], "upload-symlink"],
        [["../outside.txt"], "upload-outside-workspace"],
        [[join(workspace, "notes.txt")], "upload-outside-workspace"],
        [["missing.txt"], "upload-not-found"],
      ] as const) {
        const refused = await tool.call({ operation: "upload", selector: "#file", files });
        expect(refused.result).toEqual({ error: reason });
      }
      await tool.stop();
      const declined = agentTool({ uploadRoot: workspace, uploadAnswer: "denied" });
      await declined.call({ operation: "navigate", url: `${origin}/controls` });
      const no = await declined.call({
        operation: "upload",
        selector: "#file",
        files: ["notes.txt"],
      });
      expect(no.result).toEqual({ error: "browser-upload-denied" });
      await declined.stop();
      // A file swapped for a link while the person reads the question is not
      // what gets sent: the page receives the file that was checked.
      await writeFile(join(workspace, "secret.txt"), "a much longer secret");
      const swapped = agentTool({
        uploadRoot: workspace,
        whileAsking: async () => {
          await rm(join(workspace, "notes.txt"));
          await symlink(join(workspace, "secret.txt"), join(workspace, "notes.txt"));
        },
      });
      await swapped.call({ operation: "navigate", url: `${origin}/controls` });
      const kept = await swapped.call({
        operation: "upload",
        selector: "#file",
        files: ["notes.txt"],
      });
      expect(kept.result.page?.title).toBe("Attached notes.txt 5");
      await swapped.stop();
      const unrooted = agentTool();
      await unrooted.call({ operation: "navigate", url: `${origin}/controls` });
      const none = await unrooted.call({
        operation: "upload",
        selector: "#file",
        files: ["notes.txt"],
      });
      expect(none.result).toEqual({ error: "upload-unavailable" });
      await unrooted.stop();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("opens, lists, switches, and closes tabs, each one inside the page's allowed origin", async () => {
    const tool = agentTool();
    await tool.call({ operation: "navigate", url: `${origin}/form` });
    const opened = await tool.call({ operation: "tab-open", url: `${origin}/other` });
    expect(opened.result.page?.tabs).toEqual([
      { tabId: "t1", url: `${origin}/form`, title: "Form", active: false },
      { tabId: "t2", url: `${origin}/other`, title: "Other", active: true },
    ]);
    const switched = await tool.call({ operation: "tab-switch", tabId: "t1" });
    expect(switched.result.page?.title).toBe("Form");
    const closed = await tool.call({ operation: "tab-close", tabId: "t2" });
    expect(closed.result.page?.tabs).toEqual([
      { tabId: "t1", url: `${origin}/form`, title: "Form", active: true },
    ]);
    const last = await tool.call({ operation: "tab-close", tabId: "t1" });
    expect(last.isError).toBe(true);
    const elsewhere = await tool.call({ operation: "tab-open", url: "https://example.com/" });
    expect(elsewhere.result.failure?.category).toBe("policy-denied");
    const redirected = await tool.call({ operation: "tab-open", url: `${origin}/leave` });
    expect(redirected.result.failure?.category).toBe("policy-denied");
    const listed = await tool.call({ operation: "tab-list" });
    expect(JSON.stringify(listed.result.page?.tabs)).not.toContain("localhost");
    // A tab that wanders off the allowed origins after its own action ended
    // is listed blank, never with the other site's address or title.
    await tool.call({ operation: "tab-open", url: `${origin}/later-leave` });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const wandered = await tool.call({ operation: "tab-list" });
    expect(JSON.stringify(wandered.result.page?.tabs)).not.toContain("localhost");
    expect(JSON.stringify(wandered.result.page?.tabs)).not.toContain("Other");
    await tool.stop();
  });
});
