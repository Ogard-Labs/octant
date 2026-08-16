#!/usr/bin/env bun
/**
 * Development loop for the desktop app:
 *
 *   1. Start the web renderer on Vite with hot reload.
 *   2. Wait until it answers.
 *   3. Launch Electron pointed at it via `OCTANT_WEB_URL`.
 *
 * The desktop shell spawns the server from source, so server edits only need
 * an app relaunch. Renderer edits hot-reload. Only `apps/desktop/src` edits
 * need `bun run --cwd apps/desktop build` (this script runs it once when the
 * bundle is missing).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
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

const desktopBundle = resolve(root, "apps/desktop/dist/main.mjs");
if (!existsSync(desktopBundle)) {
  console.log("[dev] building desktop shell once (apps/desktop/dist missing)…");
  const build = Bun.spawnSync(["bun", "run", "--cwd", "apps/desktop", "build"], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (build.exitCode !== 0) shutdown(build.exitCode ?? 1);
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
  env: { ...process.env, OCTANT_WEB_URL: webUrl },
  stdio: ["inherit", "inherit", "inherit"],
});
children.push(electron);
const exitCode = await electron.exited;
console.log(`[dev] Electron exited (${exitCode})`);
shutdown(exitCode ?? 0);
