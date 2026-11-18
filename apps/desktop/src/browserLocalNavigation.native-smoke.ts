import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { decodeBrowserContextId, decodeBrowserContextPolicy } from "@octant/contracts";
import { createBrowserSurfaceHost } from "./browserSurfaceHost";
import { createOffscreenBrowserSurface } from "./offscreenBrowserSurface";

/**
 * The real-Electron proof of the desktop page-started local-navigation guard:
 * the production surface host over a hidden offscreen window, on a Private `*`
 * window context, against a fixture server where `*.octant.test` names are
 * public and `127.0.0.1`/`localhost` are this computer. Mocks cannot prove the
 * real navigation-event ordering or that `initiator === mainFrame`, so each
 * refused scenario is asserted twice: the local path was never requested and
 * the context never observed the local page.
 */
async function probe(root: string) {
  app.commandLine.appendSwitch(
    "host-resolver-rules",
    "MAP *.octant.test 127.0.0.1,MAP *.elsewhere.test 127.0.0.1",
  );
  app.disableHardwareAcceleration();
  mkdirSync(join(root, "profile"), { mode: 0o700 });
  app.setPath("userData", join(root, "profile"));
  const hits = new Map<string, number>();
  const count = (path: string) => hits.get(path) ?? 0;
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    hits.set(path, count(path) + 1);
    const port = (server.address() as AddressInfo).port;
    const page = (body: string) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(body);
    };
    const moved = (location: string) => {
      response.writeHead(302, { location });
      response.end();
    };
    if (path === "/pub-idle")
      return page(`<!doctype html><title>Public idle</title><p>Public idle page</p>
        <script>setTimeout(() => { location.href = "http://127.0.0.1:${port}/local"; }, 150);</script>`);
    if (path === "/pub-meta")
      return page(`<!doctype html><title>Public meta</title><p>Public meta page</p>
        <meta http-equiv="refresh" content="0; url=http://127.0.0.1:${port}/local-meta">`);
    if (path === "/pub-link-red")
      return page(`<!doctype html><title>Public link</title><p>Public linked page</p>
        <a id="go" href="/red-local">Go local</a>`);
    if (path === "/red-local") return moved(`http://127.0.0.1:${port}/local-red`);
    if (path === "/pub-framed")
      return page(`<!doctype html><title>Public framed</title><p>Public framed page</p>
        <iframe src="http://127.0.0.1:${port}/local-frame"></iframe>`);
    // A frame committed on another public site moves itself onto this computer.
    if (path === "/pub-oopif")
      return page(`<!doctype html><title>Public framed</title><p>Public framed page</p>
        <iframe src="http://x.elsewhere.test:${port}/inner-mover"></iframe>`);
    if (path === "/inner-mover")
      return page(`<!doctype html><title>Inner mover</title><p>Elsewhere frame</p>
        <script>setTimeout(() => { location.href = "http://127.0.0.1:${port}/local-frame"; }, 300);</script>`);
    if (path === "/pub-roundtrip") return moved(`http://127.0.0.1:${port}/local-final`);
    // The named load lands on a local origin no open has committed to yet.
    if (path === "/short-local") return moved(`http://localhost:${port}/local-short`);
    if (path === "/local")
      return page(`<!doctype html><title>Local</title><p>Local intranet panel</p>`);
    // The committed page moves itself: a same-origin hop, then a same-origin
    // redirect, then stays put. Page-started like a link the person followed.
    if (path === "/local-chain")
      return page(`<!doctype html><title>Local chain</title><p>Local chain page</p>
        <script>setTimeout(() => { location.href = "/local-chain-next"; }, 300);</script>`);
    if (path === "/local-chain-next")
      return page(`<!doctype html><title>Local chain next</title><p>Local chain next page</p>
        <script>setTimeout(() => { location.href = "/local-chain-redir"; }, 300);</script>`);
    if (path === "/local-chain-redir") return moved(`http://127.0.0.1:${port}/local-chain-deep`);
    if (path === "/local-chain-deep")
      return page(`<!doctype html><title>Local chain deep</title><p>Local chain deep page</p>`);
    // A same-origin page started from here aims at another local origin.
    if (path === "/local-away")
      return page(`<!doctype html><title>Local away</title><p>Local away page</p>
        <script>setTimeout(() => { location.href = "http://localhost:${port}/local-else"; }, 300);</script>`);
    if (path === "/local-else")
      return page(`<!doctype html><title>Local else</title><p>Elsewhere on the network</p>`);
    // A move out to a public name whose own redirect points back at this page.
    if (path === "/local-round")
      return page(`<!doctype html><title>Local round</title><p>Local round page</p>
        <script>setTimeout(() => { location.href = "http://a.octant.test:${port}/pub-roundtrip"; }, 300);</script>`);
    if (path === "/local-final")
      return page(`<!doctype html><title>Local final</title><p>Back on the local page</p>`);
    if (path === "/local-short")
      return page(`<!doctype html><title>Local short</title><p>Named landing on the network</p>
        <script>setTimeout(() => { location.href = "http://localhost:${port}/local-short-next"; }, 300);</script>`);
    if (path === "/local-short-next")
      return page(
        `<!doctype html><title>Local short next</title><p>Continuation of the named landing</p>`,
      );
    if (path === "/local-meta" || path === "/local-red" || path === "/local-frame")
      return page(`<!doctype html><title>Local</title><p>Local intranet panel</p>`);
    response.writeHead(404, { "content-type": "text/html" });
    response.end("missing");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const local = (path: string) => `http://127.0.0.1:${port}${path}`;
  const pub = (name: string, path: string) => `http://${name}:${port}${path}`;
  await app.whenReady();
  const host = createBrowserSurfaceHost({
    createView: (options) => createOffscreenBrowserSurface(options),
    isOwnerWindowAvailable: () => true,
  });
  const checks: string[] = [];
  try {
    const contextId = decodeBrowserContextId(randomUUID());
    // A `*` allowlist is the Private page. An execution lease cannot carry it —
    // its binding admits only concrete origins — so a Private page lives on a
    // window owner; the navigation guard and `act` are identical for both.
    const policy = decodeBrowserContextPolicy({
      profileMode: "isolated",
      profile: { kind: "personal" },
      allowedOrigins: ["*"],
      credentialFieldProtection: true,
      maxConcurrentTabs: 4,
      sessionTimeoutMs: 60_000,
    });
    await host.createContext({
      contextId,
      owner: { windowId: "local-navigation-smoke-window", threadId: randomUUID() },
      policy,
    });
    const mark = (step: string) => steps.push(step);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 1_200));
    const state = () => host.state(contextId);
    const navigate = (target: string, person = false) => {
      mark(`navigate ${target}${person ? " (person)" : ""}`);
      return host.act(contextId, {
        kind: "navigate",
        target,
        ...(person ? { startedBy: "person" as const } : {}),
      });
    };
    // The agent reads the page between inputs: a snapshot resets the staleness
    // counter the person's-input guard checks before a click may run.
    const snapshot = () => host.act(contextId, { kind: "snapshot" });
    const click = async (selector: string) => {
      mark(`snapshot before ${selector}`);
      await snapshot();
      mark(`click ${selector}`);
      await host.act(contextId, { kind: "click", target: selector });
      mark(`clicked ${selector}`);
    };
    const until = async (holds: () => boolean, ms = 8_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (holds()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    /**
     * A refused hop leaves the page it started on: no request reached the
     * target's path and the context still shows the page it came from.
     */
    const refused = (
      checkName: string,
      before: number,
      path: string,
      stays: (current: { url: string; title: string }) => boolean,
    ) => {
      if (count(path) !== before)
        throw Error(`${checkName}: ${path} was requested ${String(count(path) - before)} times.`);
      const current = state();
      if (!stays(current))
        throw Error(`${checkName}: the context observed ${current.url} (${current.title}).`);
      checks.push(checkName);
    };
    const landed = async (checkName: string, url: string, title: string) => {
      await until(() => state().url === url);
      const current = state();
      if (current.url !== url || current.title !== title)
        throw Error(`${checkName}: observed ${current.url} (${current.title}), wanted ${url}.`);
      checks.push(checkName);
    };

    // An idle page's own script hop onto this computer is refused.
    await navigate(pub("a.octant.test", "/pub-idle"));
    const idleBefore = count("/local");
    await settle();
    refused("idle-page-script-hop", idleBefore, "/local", (current) =>
      current.url.startsWith(`http://a.octant.test:${String(port)}`),
    );

    // A meta refresh onto this computer is refused.
    await navigate(pub("a.octant.test", "/pub-meta"));
    const metaBefore = count("/local-meta");
    await settle();
    refused("meta-refresh", metaBefore, "/local-meta", (current) =>
      current.url.startsWith(`http://a.octant.test:${String(port)}`),
    );

    // A public link's redirect onto this computer is refused on the local hop.
    await navigate(pub("a.octant.test", "/pub-link-red"));
    const redBefore = count("/local-red");
    await click("#go");
    await settle();
    refused("link-redirect-to-local", redBefore, "/local-red", (current) =>
      current.url.startsWith(`http://a.octant.test:${String(port)}`),
    );

    // A public page's frame onto this computer is refused.
    await navigate(pub("a.octant.test", "/pub-framed"));
    const frameBefore = count("/local-frame");
    await settle();
    refused("subframe-to-local", frameBefore, "/local-frame", (current) =>
      current.url.startsWith(`http://a.octant.test:${String(port)}`),
    );

    // A frame committed on another public site cannot move itself onto this
    // computer either: its own hop is refused the same way.
    await navigate(pub("a.octant.test", "/pub-oopif"));
    const moverBefore = count("/local-frame");
    await settle();
    refused("cross-site-frame-self-hop", moverBefore, "/local-frame", (current) =>
      current.url.startsWith(`http://a.octant.test:${String(port)}`),
    );

    // The person opens a local address they typed.
    await navigate(local("/local"), true);
    await landed("person-typed-local-open", local("/local"), "Local");

    // The agent opens a local address it names; the committed page continues on
    // its exact origin — a page-started move, then a same-origin redirect. The
    // hops are timed, so each check accepts the page already past that point:
    // a refused hop leaves it stuck earlier in the chain.
    const chain = [local("/local-chain"), local("/local-chain-next"), local("/local-chain-deep")];
    const reached = async (checkName: string, index: number) => {
      await until(() => chain.indexOf(state().url) >= index);
      const at = chain.indexOf(state().url);
      if (at < index)
        throw Error(`${checkName}: observed ${state().url}, wanted past ${chain[index]}.`);
      checks.push(checkName);
    };
    await navigate(local("/local-chain"));
    await reached("agent-named-local-open", 0);
    await reached("same-origin-page-move", 1);
    await reached("same-origin-redirect", 2);

    // A move to a different local name on the same port is a different origin.
    await navigate(local("/local-away"));
    await landed("agent-named-local-away", local("/local-away"), "Local away");
    const elseBefore = count("/local-else");
    await settle();
    refused("different-local-origin", elseBefore, "/local-else", (current) =>
      current.url.startsWith(`http://127.0.0.1:${String(port)}/local-away`),
    );

    // A move out to a public name that redirects back is refused on the
    // return hop; the local landing is never observed.
    await navigate(local("/local-round"));
    await landed("agent-named-local-round", local("/local-round"), "Local round");
    const finalBefore = count("/local-final");
    await settle();
    refused(
      "redirect-back-to-local",
      finalBefore,
      "/local-final",
      (current) => current.url !== local("/local-final"),
    );

    // A named public address's own redirect onto this computer is followed,
    // but the landing acquired no continuation: its page-started hop is refused.
    // The landing is a local origin no explicit open committed to.
    const named = `http://localhost:${String(port)}`;
    await navigate(pub("a.octant.test", "/short-local"));
    await landed("named-redirect-to-local", `${named}/local-short`, "Local short");
    const shortNextBefore = count("/local-short-next");
    await settle();
    refused(
      "named-redirect-no-continuation",
      shortNextBefore,
      "/local-short-next",
      (current) => current.url === `${named}/local-short`,
    );

    return { status: "passed", checks, port };
  } catch (error) {
    const done = checks.length === 0 ? "none" : checks.join(", ");
    throw Error(
      `${error instanceof Error ? error.message : String(error)} — checks passed: ${done}`,
    );
  } finally {
    await host.closeAll().catch(() => undefined);
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
  }
}
const rootIndex = process.argv.indexOf("--octant-fixture-root");
const root = rootIndex < 0 ? undefined : process.argv[rootIndex + 1];
if (root === undefined) throw Error("An owned fixture root is required.");
const steps: string[] = [];
const pending = probe(root);
void pending.catch(() => undefined);
Object.defineProperty(globalThis, "__octantLocalNavigationProbe", { value: pending });
Object.defineProperty(globalThis, "__octantLocalNavigationSteps", {
  get: () => ({
    steps: [...steps],
    views: BrowserWindow.getAllWindows().map((window) => ({
      url: window.webContents.getURL(),
      loading: window.webContents.isLoading(),
      debuggerAttached: window.webContents.debugger.isAttached(),
      destroyed: window.webContents.isDestroyed(),
    })),
  }),
});
