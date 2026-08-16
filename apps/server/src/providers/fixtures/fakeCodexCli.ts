#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_CODEX_MODE ?? "ready";
const root = process.env.FAKE_CODEX_ROOT;

function record(value: Record<string, unknown>): void {
  if (root !== undefined) appendFileSync(join(root, "records.jsonl"), `${JSON.stringify(value)}\n`);
}

function recordPid(pid: number): void {
  record({ kind: "pid", pid });
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

function spawnDelayedVersionOutput(output: string): void {
  const child = spawn(
    "sh",
    ["-c", "sleep 0.15; printf '%s\\n' \"$1\"", "fake-codex-version-writer", output],
    { detached: false, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (child.pid !== undefined) recordPid(child.pid);
  child.unref();
}

if (process.argv.slice(2).join(" ") === "--version") {
  if (mode === "version-timeout") {
    recordPid(process.pid);
    spawnDescendant(true);
    setInterval(() => undefined, 1_000);
  } else if (mode === "version-nonzero") {
    console.error("private version failure");
    process.exit(19);
  } else if (mode === "version-delayed-output") {
    recordPid(process.pid);
    spawnDelayedVersionOutput("codex-cli 0.144.4");
    process.exit(0);
  } else if (mode === "version-delayed-noise") {
    recordPid(process.pid);
    console.log("codex-cli 0.144.4");
    spawnDelayedVersionOutput("late-noise");
    process.exit(0);
  } else if (mode === "version-oversized-valid-prefix") {
    const prefix = "codex-cli 1.2.3+";
    process.stdout.write(`${prefix}${"a".repeat(4_096 - prefix.length)}!`);
    process.exit(0);
  } else if (mode === "version-oversized-multibyte") {
    process.stderr.write("é".repeat(2_100));
    process.stdout.write("codex-cli 0.144.4\n");
    process.exit(0);
  } else {
    console.log(mode === "version-malformed" ? "Codex build 0.144.4" : "codex-cli 0.144.4");
    process.exit(0);
  }
} else {
  const args = process.argv.slice(2);
  if (args.join(" ") !== "app-server --listen stdio://") {
    console.error("invalid invocation");
    process.exit(64);
  }

  recordPid(process.pid);
  record({
    kind: "spawn",
    args,
    environment: {
      openaiApiKey: process.env.OPENAI_API_KEY !== undefined,
      octantKey: Object.keys(process.env).some((key) => key.startsWith("OCTANT_")),
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE !== undefined,
      nodeOptions: process.env.NODE_OPTIONS !== undefined,
    },
  });

  if (mode === "early-exit") {
    console.error(`raw-stderr-secret ${process.env.PRIVATE_SECRET ?? "missing"}`);
    process.exit(23);
  }

  if (mode === "stderr") console.error("raw-stderr-secret-".repeat(64));
  if (mode.endsWith("descendant") || mode.startsWith("transport-")) {
    spawnDescendant(mode === "stubborn-descendant" || mode === "backpressure-descendant");
  }

  process.on("SIGTERM", () => {
    record({ kind: "signal", signal: "SIGTERM" });
    if (mode !== "stubborn-descendant") process.exit(0);
  });

  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    input += chunk;
    let newline = input.indexOf("\n");
    while (newline >= 0) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      const message = JSON.parse(line) as {
        readonly id?: number;
        readonly method: string;
        readonly params?: unknown;
      };
      if (message.id !== undefined) {
        record({
          kind: "request",
          id: message.id,
          method: message.method,
          params: message.params,
        });
        if (!mode.startsWith("initialize-timeout")) {
          const params = message.params as
            | { readonly cwd?: string; readonly model?: string; readonly threadId?: string }
            | undefined;
          const result =
            message.method === "initialize"
              ? { userAgent: "fake-codex/0.144.4" }
              : message.method === "account/read"
                ? { account: { type: "chatgpt" }, requiresOpenaiAuth: true }
                : message.method === "model/list"
                  ? {
                      data: [
                        {
                          id: "gpt-5.4",
                          model: "gpt-5.4",
                          displayName: "GPT 5.4",
                          hidden: false,
                          supportedReasoningEfforts: [],
                          defaultReasoningEffort: "medium",
                          inputModalities: ["text"],
                          serviceTiers: [],
                          defaultServiceTier: null,
                          isDefault: true,
                        },
                      ],
                      nextCursor: null,
                    }
                  : message.method === "thread/start"
                    ? {
                        thread: { id: "thread-1" },
                        model: params?.model ?? "gpt-5.4",
                        modelProvider: "openai",
                        serviceTier: null,
                        cwd: params?.cwd ?? "/tmp/octant-codex-project",
                      }
                    : message.method === "thread/resume"
                      ? {
                          thread: { id: params?.threadId ?? "thread-1" },
                          model: "gpt-5.4",
                          modelProvider: "openai",
                          serviceTier: null,
                          cwd: "/tmp/octant-codex-project",
                        }
                      : message.method === "turn/start"
                        ? { turn: { id: "turn-1", status: "inProgress" } }
                        : {};
          process.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
        }
      } else {
        record({ kind: "notification", method: message.method });
        if (mode === "backpressure-descendant" && message.method === "initialized") {
          record({ kind: "stdin-paused" });
          process.stdin.pause();
        }
        if (message.method === "test/triggerTransportFailure") {
          if (mode === "transport-corrupt") process.stdout.write("{malformed-json\n");
        }
      }
      newline = input.indexOf("\n");
    }
  });

  setInterval(() => undefined, 1_000);
}
