import { randomUUID } from "node:crypto";
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
    const body = pages[new URL(request.url ?? "/", "http://localhost").pathname];
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

function agentTool() {
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
    approvals: { request: async () => "approved" as const },
    uuid: () => randomUUID(),
  });
  const call = async (input: Record<string, unknown>) => {
    const answer = await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify(input),
    });
    return answer as {
      readonly isError: boolean;
      readonly result: {
        readonly failure?: { readonly category: string };
        readonly page?: Record<string, unknown> & { readonly snapshot?: string };
      };
    };
  };
  return { call, stop: () => call({ operation: "stop" }) };
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
});
