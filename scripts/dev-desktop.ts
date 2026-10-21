#!/usr/bin/env bun
/**
 * Development loop for the desktop app:
 *
 *   1. Start the web renderer on Vite with hot reload.
 *   2. Wait until it answers.
 *   3. Launch Electron pointed at it via `OCTANT_WEB_URL`.
 *
 * The desktop shell spawns the server from source, so server edits only need
 * an app relaunch. Renderer edits hot-reload. `apps/desktop/src` edits are
 * bundled here on launch whenever a source file is newer than the bundle, so a
 * relaunch always runs the desktop code that is checked out.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCanvasPreviewPage } from "../packages/cli/src/canvasPreviewPage";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const webRoot = resolve(root, "apps/web");
const port = Number(process.env.OCTANT_DEV_WEB_PORT ?? "5173");
const webUrl = `http://localhost:${port}`;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

function shutdown(code = 0): never {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

const desktopBundle = resolve(root, "apps/desktop/dist/entry.mjs");
const desktopSource = resolve(root, "apps/desktop/src");

function newestModifiedAt(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const modifiedAt = entry.isDirectory() ? newestModifiedAt(path) : statSync(path).mtimeMs;
    if (modifiedAt > newest) newest = modifiedAt;
  }
  return newest;
}

const desktopBundleStale =
  !existsSync(desktopBundle) || statSync(desktopBundle).mtimeMs < newestModifiedAt(desktopSource);
if (desktopBundleStale) {
  console.log("[dev] building desktop shell (apps/desktop/src is newer than the bundle)…");
  const build = Bun.spawnSync(["bun", "run", "--cwd", "apps/desktop", "build"], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (build.exitCode !== 0) shutdown(build.exitCode ?? 1);
}

// Vite serves the renderer, but the host screenshots a Canvas from the preview
// page built beside the web app, so the page is built here when it is missing
// or older than the renderer's sources. A failed build is not fatal: previews
// report no renderer, the way they did before, until the build succeeds.
const previewPage = await ensureCanvasPreviewPage({ webRoot });
if (previewPage.status === "built") {
  console.log("[dev] built the Canvas preview page (apps/web was newer than the page)");
}
if (previewPage.status === "failed") {
  console.error(
    `[dev] the Canvas preview page did not build (exit code ${String(previewPage.exitCode)}); previews report no renderer until \`bun run --cwd apps/web build:canvas-preview\` succeeds`,
  );
}

console.log(`[dev] starting web renderer on ${webUrl}`);
const vite = Bun.spawn(
  ["bun", "run", "--cwd", "apps/web", "dev", "--port", String(port), "--strictPort"],
  { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
);
children.push(vite);
void vite.exited.then((code) => {
  console.error(`[dev] web renderer exited (${code})`);
  shutdown(code ?? 1);
});

const deadline = Date.now() + 30_000;
for (;;) {
  try {
    const response = await fetch(webUrl, { method: "HEAD" });
    if (response.ok || response.status === 404) break;
  } catch {
    // Not up yet.
  }
  if (Date.now() > deadline) {
    console.error(`[dev] web renderer did not answer on ${webUrl} within 30s`);
    shutdown(1);
  }
  await Bun.sleep(250);
}

console.log("[dev] launching Electron");
const electron = Bun.spawn(["bun", "run", "--cwd", "apps/desktop", "start"], {
  cwd: root,
  env: {
    ...process.env,
    OCTANT_DEV_WEB_BOOTSTRAP: "1",
    OCTANT_WEB_URL: webUrl,
    // The host Electron starts from source inherits this and finds the Canvas
    // preview page under the web build; the renderer itself stays on Vite.
    OCTANT_WEB_DIST_PATH: resolve(webRoot, "dist"),
  },
  stdio: ["inherit", "inherit", "inherit"],
});
children.push(electron);
const exitCode = await electron.exited;
console.log(`[dev] Electron exited (${exitCode})`);
shutdown(exitCode ?? 0);
