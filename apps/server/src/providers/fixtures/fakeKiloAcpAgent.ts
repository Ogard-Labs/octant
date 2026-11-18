#!/usr/bin/env bun

/**
 * A stand-in for Kilo's ACP agent, compiled to a Windows program by the
 * Windows CI job (`bun build --compile`), where the shell and Python fixture
 * the Linux suites use cannot be started as a provider. It answers the version
 * read and ACP's `initialize`, and runs until its input closes.
 */

import { createInterface } from "node:readline";

if (process.argv.slice(2).join(" ") === "--version") {
  console.log("7.4.11");
  process.exit(0);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message: { readonly id?: unknown; readonly method?: unknown };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return;
  }
  if (message.method !== "initialize" || message.id === undefined) return;
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true },
        },
        authMethods: [],
        agentInfo: { name: "Kilo", title: "Kilo", version: "7.4.11" },
      },
    })}\n`,
  );
});
lines.on("close", () => process.exit(0));
