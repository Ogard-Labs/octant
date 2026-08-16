#!/usr/bin/env bun

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const modePath = join(process.cwd(), ".fake-opencode-mode");
const pidPath = join(process.cwd(), ".fake-opencode-pids");

function mode(): string {
  if (process.env.OCTANT_FAKE_OPENCODE_MODE) {
    return process.env.OCTANT_FAKE_OPENCODE_MODE;
  }
  try {
    return readFileSync(modePath, "utf8").trim();
  } catch {
    return "ready";
  }
}

function recordPid(pid: number): void {
  appendFileSync(pidPath, `${pid}\n`);
}

function spawnDescendant(stubborn: boolean): void {
  const child = Bun.spawn(
    stubborn
      ? ["sh", "-c", "trap '' TERM; while :; do sleep 1; done"]
      : ["sh", "-c", "while :; do sleep 1; done"],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  recordPid(child.pid);
}

if (process.argv.slice(2).join(" ") === "--version") {
  const selectedMode = mode();
  if (selectedMode.startsWith("probe-")) recordPid(process.pid);
  if (selectedMode === "probe-success-descendant") spawnDescendant(false);
  if (selectedMode === "probe-failure-descendant") {
    spawnDescendant(false);
    console.error("probe failed");
    process.exit(17);
  }
  console.log(selectedMode === "probe-misleading-version" ? "OpenCode build 1.17.19" : "1.17.19");
  process.exit(0);
}

if (
  process.argv.slice(2).join(" ") !== "serve --hostname 127.0.0.1 --port 0" ||
  process.env.OPENCODE_SERVER_USERNAME !== "octant" ||
  !process.env.OPENCODE_SERVER_PASSWORD
) {
  console.error("invalid invocation");
  process.exit(64);
}

recordPid(process.pid);
const selectedMode = mode();

if (selectedMode === "early-exit") {
  console.error(
    `private=${process.env.PRIVATE_SECRET} password=${process.env.OPENCODE_SERVER_PASSWORD}`,
  );
  process.exit(23);
}

if (selectedMode === "non-loopback") {
  console.log("opencode server listening on http://0.0.0.0:43210");
  setInterval(() => undefined, 1_000);
} else if (selectedMode === "misleading-line") {
  console.log("INFO opencode server listening on http://127.0.0.1:43210 extra");
  setInterval(() => undefined, 1_000);
} else if (selectedMode === "no-ready" || selectedMode === "stubborn") {
  spawnDescendant(selectedMode === "stubborn");
  if (selectedMode === "stubborn") process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 1_000);
} else {
  if (selectedMode === "ready-stubborn") spawnDescendant(true);
  const username = process.env.OPENCODE_SERVER_USERNAME;
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return request.headers.get("authorization") === expectedAuthorization
        ? new Response("ok")
        : new Response("unauthorized", { status: 401 });
    },
  });
  console.log(`opencode server listening on http://127.0.0.1:${server.port}`);
}
