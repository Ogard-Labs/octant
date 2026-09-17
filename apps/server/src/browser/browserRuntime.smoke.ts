import { randomUUID } from "node:crypto";
import type { BrowserActionRequest, BrowserContextId } from "@octant/contracts";
import { MAX_BROWSER_TABS_PER_CONTEXT } from "@octant/contracts";
import { createPlaywrightBrowserRuntime } from "./playwrightBrowserRuntime";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/dynamic") {
      return new Response(
        `<!doctype html><title>Dynamic pending</title><p id="placeholder">pending</p><script>setTimeout(() => { const el = document.getElementById("placeholder"); el.id = "ready"; el.textContent = "ready"; document.title = "Dynamic ready"; }, 1200)</script>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (path === "/form") {
      return new Response(
        `<!doctype html><title>Form</title><form id="f"><input id="name" name="name"><button id="send" type="submit">Send</button></form><p id="echo"></p><script>document.getElementById("name").addEventListener("input", (event) => { document.getElementById("echo").textContent = "typed:" + event.target.value; });document.getElementById("f").addEventListener("submit", (event) => { event.preventDefault(); document.title = "Submitted " + document.getElementById("name").value; });</script>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    const name = path === "/two" ? "Two" : "One";
    return new Response(
      `<!doctype html><title>${name}</title><button id="go" onclick="document.title='${name} clicked';document.body.dataset.clicked='yes'">Go</button><input id="password" type="password"><p>${name}</p>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});

const runtime = createPlaywrightBrowserRuntime();
const first = randomUUID() as BrowserContextId;
const second = randomUUID() as BrowserContextId;
const controller = new AbortController();
const policy = {
  profileMode: "isolated" as const,
  allowedOrigins: [server.url.origin],
  credentialFieldProtection: true,
  maxConcurrentTabs: MAX_BROWSER_TABS_PER_CONTEXT,
  sessionTimeoutMs: 60_000,
};
const base = {
  actionId: randomUUID(),
  correlationId: randomUUID(),
  authority: {
    hostId: randomUUID(),
    mode: "work" as const,
    projectId: randomUUID(),
    rootId: randomUUID(),
    providerInstanceId: randomUUID(),
    extension: { kind: "core" as const },
  },
};

try {
  if (!(await runtime.available())) throw new Error("No supported Chromium executable was found.");
  await runtime.createContext(first, policy, controller.signal);
  await runtime.createContext(second, policy, controller.signal);
  const request = (
    contextId: BrowserContextId,
    kind: BrowserActionRequest["kind"],
    target?: string,
  ): BrowserActionRequest =>
    ({
      ...base,
      contextId,
      kind,
      ...(target === undefined ? {} : { target }),
    }) as BrowserActionRequest;
  await runtime.act(
    first,
    request(first, "navigate", `${server.url.origin}/one`),
    controller.signal,
  );
  await runtime.act(
    second,
    request(second, "navigate", `${server.url.origin}/two`),
    controller.signal,
  );
  const clicked = await runtime.act(first, request(first, "click", "#go"), controller.signal);
  const untouched = await runtime.act(second, request(second, "extract-text"), controller.signal);
  const sensitive = await runtime.inspectTarget(first, "#password", controller.signal);
  if (clicked.title !== "One clicked" || untouched.title !== "Two" || !sensitive.sensitive) {
    throw new Error("Browser runtime smoke assertions failed.");
  }
  // The page settles after load: reading it before the wait sees the placeholder.
  await runtime.act(
    first,
    request(first, "navigate", `${server.url.origin}/dynamic`),
    controller.signal,
  );
  const pending = await runtime.act(first, request(first, "extract-text"), controller.signal);
  if (!pending.extractedText?.includes("pending")) {
    throw new Error("Dynamic fixture did not start in its placeholder state.");
  }
  await runtime.act(first, request(first, "wait", "#ready"), controller.signal);
  const settled = await runtime.act(first, request(first, "extract-text"), controller.signal);
  if (!settled.extractedText?.includes("ready") || settled.title !== "Dynamic ready") {
    throw new Error("Dynamic content was not read after it settled.");
  }
  // Semantic type and a form submit, observed through the page's own handlers.
  await runtime.act(
    first,
    request(first, "navigate", `${server.url.origin}/form`),
    controller.signal,
  );
  await runtime.act(
    first,
    { ...request(first, "type", "#name"), value: "Octant" },
    controller.signal,
  );
  const typed = await runtime.act(first, request(first, "extract-text"), controller.signal);
  if (!typed.extractedText?.includes("typed:Octant")) {
    throw new Error("Typing did not reach the page.");
  }
  const submitted = await runtime.act(first, request(first, "click", "#send"), controller.signal);
  if (submitted.title !== "Submitted Octant") {
    throw new Error("Form submit did not take effect.");
  }
  // A screenshot comes back bounded and typed as an image.
  const shot = await runtime.act(first, request(first, "screenshot"), controller.signal);
  if (
    shot.screenshotDataUrl === undefined ||
    !shot.screenshotDataUrl.startsWith("data:image/") ||
    shot.screenshotDataUrl.length > 4_000_000
  ) {
    throw new Error("Screenshot observation was missing or unbounded.");
  }
  // Stop and reconnect: the same context id acts again after a close.
  await runtime.closeContext(first);
  await runtime.createContext(first, policy, controller.signal);
  await runtime.act(
    first,
    request(first, "navigate", `${server.url.origin}/one`),
    controller.signal,
  );
  const reconnected = await runtime.act(first, request(first, "extract-text"), controller.signal);
  if (reconnected.title !== "One") {
    throw new Error("A recreated context did not act.");
  }
  await runtime.closeContext(first);
  await runtime.closeContext(second);
  console.log(
    JSON.stringify({
      status: "passed",
      isolatedContexts: 2,
      navigation: true,
      representativeInteraction: true,
      sensitiveFieldProtected: true,
      dynamicContentRead: true,
      semanticType: true,
      formSubmit: true,
      boundedScreenshot: true,
      stopAndReconnect: true,
      cleanup: true,
    }),
  );
} finally {
  await runtime.closeAll();
  server.stop(true);
}
