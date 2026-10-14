import { runTerminalLauncher } from "./terminalLauncher";

// The desktop app runs this bundle with its own runtime in Node mode; see
// apps/desktop/resources/terminal-launcher/octant.
const code = await runTerminalLauncher(process.argv.slice(2), {
  environment: process.env,
  input: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
if (code !== 0) process.exit(code);
