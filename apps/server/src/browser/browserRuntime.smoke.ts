import { randomUUID } from "node:crypto";
import type { BrowserActionRequest, BrowserContextId } from "@octant/contracts";
import { createPlaywrightBrowserRuntime } from "./playwrightBrowserRuntime";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const name = new URL(request.url).pathname === "/two" ? "Two" : "One";
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
  maxConcurrentTabs: 1,
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
  await runtime.closeContext(first);
  await runtime.closeContext(second);
  console.log(
    JSON.stringify({
      status: "passed",
      isolatedContexts: 2,
      navigation: true,
      representativeInteraction: true,
      sensitiveFieldProtected: true,
      cleanup: true,
    }),
  );
} finally {
  await runtime.closeAll();
  server.stop(true);
}
