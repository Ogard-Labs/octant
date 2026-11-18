import type { SandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import { spawnSync } from "node:child_process";
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

export function installedLinuxSandboxLaunchImage(): Buffer | undefined {
  return trustedImage === undefined ? undefined : Buffer.from(trustedImage);
}

function prepareLinuxSandboxRuntime(authority: string): string {
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
  return helper;
}

export function linuxPinnedLaunchAvailable(authority: string | undefined): boolean {
  if (process.platform !== "linux" || authority === undefined) return false;
  try {
    return (
      spawnSync(prepareLinuxSandboxRuntime(authority), ["--check"], {
        timeout: 1000,
        stdio: "ignore",
      }).status === 0
    );
  } catch {
    return false;
  }
}

export function pinLinuxLaunch(
  launch: ConfinedProcessLaunch,
  authority: string,
  selection?: SandboxPolicySelection,
  trustedNativeOwner = false,
): ConfinedProcessLaunch {
  const helper = prepareLinuxSandboxRuntime(authority);
  return pinPreparedLinuxLaunch(
    launch,
    helper,
    selection?.context.rootIdentities,
    trustedNativeOwner,
  );
}

export function pinPreparedLinuxLaunch(
  launch: ConfinedProcessLaunch,
  helper: string,
  rootIdentities?: SandboxPolicySelection["context"]["rootIdentities"],
  trustedNativeOwner = false,
): ConfinedProcessLaunch {
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
  if (
    !binaryIdentity.isFile() ||
    binaryIdentity.nlink !== 1n ||
    (binaryIdentity.mode & 0o022n) !== 0n
  )
    throw new Error(
      "Strict requires a privately owned or system-installed Bubblewrap executable without writable aliases.",
    );
  // A native provider owner intentionally retains host access for its explicit
  // one-command escape. Its command sandbox, not this lifetime wrapper, holds
  // writes. Confined workload launches must still protect the launcher itself.
  for (let i = 0; !trustedNativeOwner && i < args.length; i++) {
    if (args[i] === "--") break;
    if (args[i] !== "--bind" && args[i] !== "--dev-bind") continue;
    const source = args[i + 1];
    if (source !== undefined) {
      const root = realpathSync(source);
      if (binary === root || binary.startsWith(`${root}/`))
        throw new Error(
          "Strict cannot grant write access to its own Bubblewrap executable. Choose a narrower folder.",
        );
    }
    i += 2;
  }
  const payload = args.indexOf("--");
  if (payload < 0) throw new Error("A prepared Linux launch has no command boundary.");
  args.splice(payload + 1, 0, "/octant-strict-launch", "--exec-close", "--");
  const remount = args.findIndex(
    (value, index) => value === "--remount-ro" && args[index + 1] === "/",
  );
  args.splice(remount < 0 ? payload : remount, 0, "--ro-bind", helper, "/octant-strict-launch");
  const pins: string[] = [];
  const addPin = (index: number, path: string, target?: string) => {
    const canonical = realpathSync(path);
    const stat = statSync(canonical, { bigint: true });
    const admitted = rootIdentities?.find(
      (entry) => entry.path === path || entry.path === canonical || entry.path === target,
    );
    const expected = admitted?.identity.split(":");
    if (
      expected !== undefined &&
      (expected.length !== 2 || !expected.every((part) => /^\d+$/.test(part)))
    )
      throw new Error("Invalid admitted folder identity");
    pins.push(
      String(index),
      canonical,
      expected?.[0] ?? String(stat.dev),
      expected?.[1] ?? String(stat.ino),
    );
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
      const target = args[i + 2];
      if (source === undefined || target === undefined)
        throw new Error("Invalid prepared Linux mount.");
      addPin(i + 1, source, target);
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
