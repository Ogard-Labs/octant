#!/usr/bin/env bun

/**
 * A stand-in for Pi, compiled to a Windows program by the Windows CI job
 * (`bun build --compile`). It answers the version read and otherwise holds its
 * RPC input open, as Pi's `--mode rpc` does, until that input closes.
 */

if (process.argv.slice(2).join(" ") === "--version") {
  console.log("1.2.0");
  process.exit(0);
}

process.stdin.on("data", () => undefined);
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
