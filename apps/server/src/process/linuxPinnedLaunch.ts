import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfinedProcessLaunch } from "./seatbeltProfile";

// Capture installed code at server startup, before any selected workload can
// modify a development checkout containing the build output.
const installed =
  process.platform === "linux"
    ? [
        fileURLToPath(new URL("../../dist/native/octant-sandbox-launch", import.meta.url)),
        fileURLToPath(new URL("./native/octant-sandbox-launch", import.meta.url)),
      ].find(existsSync)
    : undefined;
const trustedImage = installed === undefined ? undefined : readFileSync(installed);

export function pinLinuxLaunch(
  launch: ConfinedProcessLaunch,
  authority: string,
): ConfinedProcessLaunch {
  if (trustedImage === undefined)
    throw new Error(
      "The installed Linux Strict launch helper is unavailable. Rebuild the host runtime before enabling Strict.",
    );
  const hash = createHash("sha256").update(trustedImage).digest("hex");
  const directory = join(realpathSync(authority), "sandbox-runtime");
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const helper = join(directory, `launch-${hash}`);
  try {
    writeFileSync(helper, trustedImage, { mode: 0o500, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const identity = statSync(helper);
  if (
    !identity.isFile() ||
    identity.nlink !== 1 ||
    (identity.mode & 0o277) !== 0 ||
    createHash("sha256").update(readFileSync(helper)).digest("hex") !== hash
  )
    throw new Error("The private Linux Strict launch helper changed.");
  let executable = launch.command;
  let args = [...launch.args];
  // Earlier process-denial launches used a shell solely to open this filter.
  // Open it in the trusted native launcher instead, before installing the wall.
  let filter: string | undefined;
  if (executable === "/bin/sh" && args[2] === "octant-bwrap") {
    executable = args[3] ?? "";
    filter = args[4];
    args = args.slice(5);
  }
  const binary = realpathSync(executable);
  const binaryIdentity = statSync(binary, { bigint: true });
  const payload = args.indexOf("--");
  if (payload < 0) throw new Error("A prepared Linux launch has no command boundary.");
  args.splice(payload + 1, 0, "/octant-strict-launch", "--exec-close", "--");
  const remount = args.findIndex(
    (value, index) => value === "--remount-ro" && args[index + 1] === "/",
  );
  args.splice(remount < 0 ? payload : remount, 0, "--ro-bind", helper, "/octant-strict-launch");
  const pins: string[] = [];
  const addPin = (index: number, path: string) => {
    const canonical = realpathSync(path);
    const stat = statSync(canonical, { bigint: true });
    pins.push(String(index), canonical, String(stat.dev), String(stat.ino));
  };
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--") break;
    if (
      [
        "--bind",
        "--ro-bind",
        "--dev-bind",
        "--bind-try",
        "--ro-bind-try",
        "--dev-bind-try",
      ].includes(option ?? "")
    ) {
      const source = args[i + 1];
      if (source === undefined) throw new Error("Invalid prepared Linux mount.");
      addPin(i + 1, source);
      i += 2;
    } else if (option === "--symlink" || option === "--setenv") i += 2;
    else if (
      [
        "--proc",
        "--dev",
        "--tmpfs",
        "--dir",
        "--chdir",
        "--remount-ro",
        "--cap-drop",
        "--uid",
        "--gid",
        "--unsetenv",
      ].includes(option ?? "")
    )
      i++;
  }
  if (filter !== undefined) {
    // --seccomp consumes an already-open descriptor; the native helper opens
    // the exact pinned filter read-only rather than exposing it to payload.
    args.unshift("--seccomp", "@filter");
    for (let i = 0; i < pins.length; i += 4) pins[i] = String(Number(pins[i]) + 2);
    addPin(1, filter);
  }
  return {
    ...launch,
    command: helper,
    args: [
      binary,
      String(binaryIdentity.dev),
      String(binaryIdentity.ino),
      String(pins.length / 4),
      ...pins,
      "--",
      ...args,
    ],
  };
}
