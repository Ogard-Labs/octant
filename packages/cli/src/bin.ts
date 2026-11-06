#!/usr/bin/env bun
import { desktopIdentity } from "@octant/host-runtime";
import { runCli } from "./cli";

export { hasInvalidLifecyclePositionals, parseArgs } from "./cli";

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), desktopIdentity("stable"));
  if (code !== 0) process.exit(code);
}
