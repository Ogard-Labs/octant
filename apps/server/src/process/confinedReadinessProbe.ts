import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { versionProbeReadRoots, type ConfinedVersionProbe } from "./confinedVersionProbe";
import {
  makeProcessConfinementLive,
  seatbeltAllowLiteralReadRule,
  type ProcessConfinementPort,
} from "./seatbeltProfile";

/** Credential status reads use their own account files, never a project or the whole home. */
export function prepareConfinedReadinessProbe(input: {
  readonly family: "codex" | "claude" | "oh-my-pi";
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly confinement?: ProcessConfinementPort;
}): ConfinedVersionProbe {
  let scratch: string | undefined;
  try {
    const environment = input.environment;
    const home = canonical(
      input.family === "oh-my-pi" ? homedir() : (environment.HOME ?? homedir()),
    );
    const configured =
      input.family === "codex"
        ? (environment.CODEX_HOME ?? join(home, ".codex"))
        : input.family === "claude"
          ? environment.CLAUDE_CONFIG_DIR || join(home, ".claude")
          : (environment.OMP_HOME ?? home);
    if (!isAbsolute(configured) || resolve(configured) !== configured || configured === sep)
      return {
        status: "refused",
        reason: "invalid-configuration",
        message: "The readiness account directory is invalid.",
      };
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "octant-readiness-probe-")));
    const directory = scratch;
    const release = () => rmSync(directory, { recursive: true, force: true });
    const executable = canonical(input.binaryPath);
    const installRoots = versionProbeReadRoots(input.binaryPath, executable, directory, home);
    const accountFiles =
      input.family === "codex"
        ? [join(configured, "auth.json"), join(configured, "config.toml")]
        : input.family === "claude"
          ? [
              join(configured, ".credentials.json"),
              join(configured, "settings.json"),
              input.environment.CLAUDE_CONFIG_DIR
                ? join(configured, ".claude.json")
                : join(home, ".claude.json"),
            ]
          : [configured];
    if (
      accountFiles.some((path) => {
        const target = canonical(path);
        return target === sep || target === home || home.startsWith(`${target}${sep}`);
      })
    ) {
      release();
      return {
        status: "refused",
        reason: "invalid-configuration",
        message: "Readiness cannot grant an entire home directory.",
      };
    }
    const keychain = process.platform === "darwin" && input.family !== "oh-my-pi";
    const readRoots = [
      ...installRoots,
      ...accountFiles,
      ...(keychain ? [join(home, "Library", "Keychains", "login.keychain-db")] : []),
    ];
    const launch = (input.confinement ?? makeProcessConfinementLive()).prepare({
      executable: input.binaryPath,
      args: input.args,
      boundRoot: directory,
      temporaryDirectory: directory,
      networkEgress: "none",
      allowProcessExec: true,
      allowProcessFork: true,
      allowFileReadStar: true,
      readRoots,
      privateHomeAllowPaths: readRoots,
      ownAccountPaths: accountFiles,
      ...(environment.PATH === undefined ? {} : { interpreterSearchPath: environment.PATH }),
      ...(keychain
        ? {
            extraRules: [
              '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
              '(allow mach-lookup (global-name "com.apple.securityd.xpc"))',
              seatbeltAllowLiteralReadRule(join(home, "Library", "Keychains", "login.keychain-db")),
            ],
          }
        : {}),
    });
    return {
      status: "prepared",
      launch: {
        ...launch,
        workingDirectory: directory,
        environment: { ...environment, TMPDIR: directory, TMP: directory, TEMP: directory },
        release,
      },
    };
  } catch {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    return {
      status: "refused",
      reason: "incompatible",
      message: "The credential-readiness probe could not be confined.",
    };
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
