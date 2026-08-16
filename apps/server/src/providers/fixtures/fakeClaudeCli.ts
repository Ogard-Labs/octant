#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_CLAUDE_MODE ?? "ready";
const root = process.env.FAKE_CLAUDE_ROOT;
const args = process.argv.slice(2);

function record(value: Record<string, unknown>): void {
  if (root !== undefined) appendFileSync(join(root, "records.jsonl"), `${JSON.stringify(value)}\n`);
}

function recordPid(pid: number): void {
  record({ kind: "pid", pid });
}

function spawnDescendant(stubborn: boolean): void {
  const child = spawn(
    "sh",
    ["-c", stubborn ? "trap '' TERM; while :; do sleep 1; done" : "while :; do sleep 1; done"],
    { detached: false, stdio: "ignore" },
  );
  if (child.pid !== undefined) recordPid(child.pid);
}

function spawnSlowDescendant(): void {
  const child = spawn(
    "sh",
    [
      "-c",
      `trap 'printf "%s\\n" "$2" >> "$1"; sleep 1; exit 0' TERM; while :; do sleep 1; done`,
      "slow-descendant",
      root === undefined ? "/dev/null" : join(root, "records.jsonl"),
      JSON.stringify({ kind: "signal", signal: "SIGTERM", target: "slow-descendant" }),
    ],
    { detached: false, stdio: "ignore" },
  );
  if (child.pid !== undefined) recordPid(child.pid);
}

async function waitForever(withDescendant: boolean): Promise<never> {
  recordPid(process.pid);
  if (withDescendant) spawnDescendant(true);
  await new Promise(() => undefined);
  throw new Error("unreachable");
}

if (args.join(" ") === "--version") {
  record({ kind: "invocation", args });
  if (mode === "version-timeout") await waitForever(true);
  if (mode === "version-nonzero") {
    process.stderr.write("private-version-failure-sentinel");
    process.exit(19);
  }
  if (mode === "version-malformed") {
    console.log("Claude development build");
    process.exit(0);
  }
  if (mode === "version-stdout-overflow") {
    process.stdout.write(`2.1.210 (Claude Code)\n${"x".repeat(8_192)}`);
    process.exit(0);
  }
  if (mode === "version-stderr-overflow") {
    process.stderr.write("private-stderr-sentinel".repeat(512));
    console.log("2.1.210 (Claude Code)");
    process.exit(0);
  }
  if (mode === "version-root-exits-first") {
    recordPid(process.pid);
    spawnSlowDescendant();
    await new Promise((resolve) => setTimeout(resolve, 100));
    console.log("2.1.210 (Claude Code)");
    process.exit(0);
  }
  console.log("2.1.210 (Claude Code)");
  process.exit(0);
}

if (args.join(" ") === "auth status --json") {
  record({ kind: "invocation", args });
  if (mode === "auth-timeout") await waitForever(true);
  if (mode === "auth-delayed-authenticated") {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  }
  if (mode === "auth-malformed") {
    console.log('{"loggedIn":"yes"}');
    process.exit(0);
  }
  if (mode === "auth-stdout-overflow") {
    process.stdout.write(`{"loggedIn":true,"padding":"${"x".repeat(8_192)}"}`);
    process.exit(0);
  }
  if (mode === "auth-stderr-overflow") {
    process.stderr.write("private-auth-stderr-sentinel".repeat(512));
    console.log('{"loggedIn":true}');
    process.exit(0);
  }
  if (mode === "auth-unauthenticated") {
    console.log('{"loggedIn":false}');
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      loggedIn: true,
      authMethod: "provider-native",
      emailAddress: "private-account-sentinel@example.invalid",
      subscriptionType: "private-subscription-sentinel",
    }),
  );
  process.exit(0);
}

if (args.join(" ") !== "sdk-test") {
  process.stderr.write("unsupported fake Claude invocation");
  process.exit(64);
}

recordPid(process.pid);
record({
  kind: "spawn",
  args,
  environment: {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY !== undefined,
    octantAuthority: Object.keys(process.env).some((key) => key.startsWith("OCTANT_")),
  },
});

if (mode === "spawn-stderr") process.stderr.write("private-runtime-stderr-sentinel".repeat(512));
if (mode === "spawn-stubborn") spawnDescendant(true);
if (mode === "spawn-root-exits-first") {
  spawnDescendant(true);
  setTimeout(() => process.exit(0), 25);
}

process.on("SIGTERM", () => {
  record({ kind: "signal", signal: "SIGTERM" });
  if (mode !== "spawn-stubborn") process.exit(0);
});

process.stdin.resume();
setInterval(() => undefined, 1_000);
