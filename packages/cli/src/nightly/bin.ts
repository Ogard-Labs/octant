import { desktopIdentity } from "@octant/host-runtime";
import { runCli } from "../cli";

// `octant-nightly`: the same command-line tool under Nightly's identity record.
// Octant Nightly runs this bundle with its worker runtime in Node mode; see
// `nightlyCommandLauncherScript` in scripts/package-desktop.ts.
const code = await runCli(process.argv.slice(2), desktopIdentity("nightly"));
if (code !== 0) process.exit(code);
