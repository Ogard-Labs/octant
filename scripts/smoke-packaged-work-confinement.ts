import { execFile } from "node:child_process";
import { link, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packageWorkConfinementGate } from "./package-work-confinement-gate";

const execFileAsync = promisify(execFile);

export const EXPECTED_RESULTS = {
  authentication: {
    "trusted-peer": "allowed",
    "foreign-client": "denied",
    "broker-rejection-evidence": "allowed",
  },
  lifecycle: {
    selection: "allowed",
    "fresh-package-relaunch": "allowed",
    stale: "stale",
    revoked: "denied",
    "old-generation-replay": "denied",
  },
  cleanup: {
    "process-cleanup": "clean",
  },
} as const;

export const requiredEvidence = {
  authentication: {
    "foreign-client": "NSXPCConnectionInterrupted4097",
    "broker-rejection-evidence": "ExactRequirementInstalled",
  },
} as const;

export const operationExpectations = {
  "allowed-create-read-write-rename-delete": "allowed",
  absolute: "denied",
  traversal: "denied",
  symlink: "denied",
  hardlink: "denied",
  mount: "denied",
  unicode: "denied",
  race: "denied",
  archive: "denied",
  process: "denied",
  "loopback-network": "denied",
  "external-network": "denied",
} as const;

export type ProbeResult = {
  readonly probe: string;
  readonly result: string;
  readonly category: string;
};

export function validateProbeResults(
  expected: Readonly<Record<string, string>>,
  actual: readonly ProbeResult[],
  evidence: Readonly<Record<string, string>> = {},
): void {
  const seen = new Set<string>();
  for (const result of actual) {
    if (seen.has(result.probe) || expected[result.probe] === undefined) {
      throw new Error("Work confinement gate failed: duplicate or unexpected probe");
    }
    seen.add(result.probe);
    if (
      expected[result.probe] !== result.result ||
      (evidence[result.probe] !== undefined && evidence[result.probe] !== result.category)
    ) {
      throw new Error(
        `Work confinement gate failed: ${result.probe} (${result.result}/${result.category})`,
      );
    }
  }
  if (seen.size !== Object.keys(expected).length) {
    throw new Error("Work confinement gate failed: missing probe");
  }
}

export function validateCompletedLifecycleProbe(result: ProbeResult): void {
  const expected =
    EXPECTED_RESULTS.lifecycle[result.probe as keyof typeof EXPECTED_RESULTS.lifecycle];
  if (expected === undefined) {
    throw new Error("Work confinement gate failed: unexpected lifecycle probe");
  }
  validateProbeResults({ [result.probe]: expected }, [result]);
}

export function validateCompleteEvidence(actual: readonly ProbeResult[]): void {
  validateProbeResults(
    {
      ...EXPECTED_RESULTS.authentication,
      ...EXPECTED_RESULTS.lifecycle,
      ...operationExpectations,
      ...EXPECTED_RESULTS.cleanup,
    },
    actual,
    requiredEvidence.authentication,
  );
}

function parseProbeResults(output: string): readonly ProbeResult[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("probe="))
    .map((line) => {
      const match = /^probe=([a-z0-9-]+) result=([a-z]+) category=([A-Za-z0-9]+)$/.exec(line);
      if (!match) throw new Error("Work confinement gate failed: malformed probe output");
      return { probe: match[1] ?? "", result: match[2] ?? "", category: match[3] ?? "" };
    });
}

async function runWithTimeout(command: readonly string[], timeoutMilliseconds: number) {
  const child = Bun.spawn(command, {
    env: {
      HOME: process.env.HOME,
      LANG: "C",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: process.env.TMPDIR,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMilliseconds);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) {
    throw new Error(
      `Work confinement host failed with category ProcessExit${exitCode}: ${stderr.length > 0 ? "stderr" : "no-stderr"}`,
    );
  }
  return stdout;
}

async function runMountFixtureStage(stage: string, arguments_: readonly string[]): Promise<void> {
  try {
    await execFileAsync("/usr/bin/hdiutil", [...arguments_], {
      timeout: 30_000,
      maxBuffer: 1_048_576,
    });
  } catch {
    throw new Error(`Unproven — mounted fixture ${stage} failed`);
  }
}

async function exactProcessIdentifiers(executable: string, mode: string): Promise<Set<number>> {
  const output = await runWithTimeout(["/bin/ps", "-axo", "pid=,command="], 30_000);
  const exactCommand = `${executable} ${mode}`;
  return new Set(
    output
      .split("\n")
      .map((line) => /^(\s*\d+)\s+(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null && match[2] === exactCommand)
      .map((match) => Number(match[1])),
  );
}

async function waitForExactProcess(executable: string, mode: string, processIdentifier: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await exactProcessIdentifiers(executable, mode)).has(processIdentifier)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Work confinement cleanup failed: owned process did not start");
}

function optionValue(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

export async function smokePackagedWorkConfinement(
  stage = optionValue("--stage") ?? "all",
): Promise<void> {
  if (stage === "all") {
    const combinedResults: ProbeResult[] = [];
    const script = fileURLToPath(import.meta.url);
    for (const childStage of ["authentication", "lifecycle", "operations", "cleanup"]) {
      const output = await runWithTimeout(
        [process.execPath, script, "--stage", childStage],
        30_000,
      );
      combinedResults.push(...parseProbeResults(output));
    }
    validateCompleteEvidence(combinedResults);
    for (const result of combinedResults) {
      process.stdout.write(
        `probe=${result.probe} result=${result.result} category=${result.category}\n`,
      );
    }
    return;
  }
  if (
    stage !== "authentication" &&
    stage !== "lifecycle" &&
    stage !== "operations" &&
    stage !== "cleanup"
  ) {
    throw new Error(`Work confinement gate failed: unsupported stage ${stage}`);
  }
  const temporaryRoot = resolve(import.meta.dirname, "../out/work-confinement-gate/smoke");
  const launchServicesRegister =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  await rm(temporaryRoot, { recursive: true, force: true });
  let appBundle: string | undefined;
  try {
    appBundle = await packageWorkConfinementGate(temporaryRoot);
    const resultFile = resolve(
      homedir(),
      "Library/Containers/app.octant.desktop.work-confinement-gate/Data/Library/Application Support/Octant Work Confinement Gate/probe-results.txt",
    );
    await rm(resultFile, { force: true });
    await runWithTimeout([launchServicesRegister, "-f", appBundle], 30_000);
    const launchAndRead = async (mode: string) => {
      await rm(resultFile, { force: true });
      await runWithTimeout(["/usr/bin/open", "-W", "-n", appBundle!, "--args", mode], 30_000);
      const output = await readFile(resultFile, "utf8");
      await rm(resultFile, { force: true });
      return parseProbeResults(output);
    };

    const selectAndRead = async (selectedRoot: string) => {
      await launchAndRead("revoke-state");
      await rm(resultFile, { force: true });
      const selectionProcess = Bun.spawn(
        [resolve(appBundle!, "Contents/MacOS/OctantWorkConfinementGate"), "select"],
        {
          env: {
            HOME: process.env.HOME,
            LANG: "C",
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            TMPDIR: process.env.TMPDIR,
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const automation = String.raw`on run argv
set targetPath to item 1 of argv
set targetPID to item 2 of argv as integer
tell application "System Events"
  repeat 100 times
    if (count of (every process whose unix id is targetPID)) > 0 then exit repeat
    delay 0.1
  end repeat
  set targetProcess to first process whose unix id is targetPID
  set frontmost of targetProcess to true
  delay 2
  keystroke "g" using {command down, shift down}
  delay 0.5
  keystroke targetPath
  key code 36
  delay 5
  if (count of (every process whose unix id is targetPID)) > 0 then key code 36
end tell
end run`;
      let selectionOutput: string | undefined;
      try {
        await runWithTimeout(
          ["/usr/bin/osascript", "-e", automation, selectedRoot, String(selectionProcess.pid)],
          30_000,
        );
        for (let attempt = 0; attempt < 250; attempt += 1) {
          try {
            selectionOutput = await readFile(resultFile, "utf8");
            break;
          } catch {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
          }
        }
      } finally {
        selectionProcess.kill("SIGTERM");
        await selectionProcess.exited;
      }
      if (selectionOutput === undefined) {
        throw new Error("Work confinement gate failed: selection result unavailable");
      }
      const selectionResults = [...parseProbeResults(selectionOutput)];
      const selectionResult = selectionResults.find((result) => result.probe === "selection");
      if (selectionResult === undefined) {
        throw new Error("Work confinement gate failed: missing selection probe");
      }
      validateCompletedLifecycleProbe(selectionResult);
      return selectionResults;
    };

    let results: readonly ProbeResult[];
    if (stage === "authentication") {
      results = await launchAndRead("authentication");
      validateProbeResults(
        EXPECTED_RESULTS.authentication,
        results,
        requiredEvidence.authentication,
      );
    } else if (stage === "lifecycle") {
      const selectedRoot = resolve(temporaryRoot, "fixture-selected");
      const renamedRoot = resolve(temporaryRoot, "fixture-renamed");
      await mkdir(selectedRoot, { recursive: true });
      const lifecycleResults = await selectAndRead(selectedRoot);
      const freshResults = await launchAndRead("authority-fresh");
      const freshResult = freshResults.find((result) => result.probe === "fresh-package-relaunch");
      if (freshResult === undefined) {
        throw new Error("Work confinement gate failed: missing fresh-package-relaunch probe");
      }
      validateCompletedLifecycleProbe(freshResult);
      lifecycleResults.push(...freshResults);
      await rename(selectedRoot, renamedRoot);
      try {
        const staleResults = await launchAndRead("authority-stale");
        if (staleResults[0]?.result !== "stale") {
          throw new Error("Unproven — stale fixture not produced by same-volume rename");
        }
        lifecycleResults.push(...staleResults);
      } finally {
        await rename(renamedRoot, selectedRoot);
      }
      await launchAndRead("revoke-state");
      results = lifecycleResults;
      validateProbeResults(EXPECTED_RESULTS.lifecycle, results);
    } else if (stage === "operations") {
      const selectedRoot = resolve(temporaryRoot, "fixture-selected");
      const outsideSentinel = resolve(temporaryRoot, "outside-sentinel");
      const imagePath = resolve(temporaryRoot, "fixture.sparseimage");
      const mountPoint = resolve(selectedRoot, "mounted");
      const sentinel = "outside-unchanged";
      let mounted = false;
      let operationFailure: unknown;
      await mkdir(resolve(selectedRoot, "race-parent"), { recursive: true });
      await mkdir(resolve(selectedRoot, "race-replacement"), { recursive: true });
      await mkdir(mountPoint, { recursive: true });
      await writeFile(outsideSentinel, sentinel);
      await writeFile(resolve(selectedRoot, "hardlink-source"), "hardlink");
      await link(resolve(selectedRoot, "hardlink-source"), resolve(selectedRoot, "hardlink"));
      await symlink(outsideSentinel, resolve(selectedRoot, "symlink"));
      await writeFile(resolve(selectedRoot, "é.txt"), "unicode");
      await writeFile(resolve(selectedRoot, "race-parent", "fixture"), "race-original");
      await writeFile(resolve(selectedRoot, "race-replacement", "fixture"), "race-replacement");
      try {
        await runMountFixtureStage("create", [
          "create",
          "-size",
          "8m",
          "-fs",
          "APFS",
          "-volname",
          "OctantConfinementFixture",
          "-type",
          "SPARSE",
          imagePath,
        ]);
        await runMountFixtureStage("attach", [
          "attach",
          "-nobrowse",
          "-mountpoint",
          mountPoint,
          imagePath,
        ]);
        mounted = true;
        const [rootMetadata, mountMetadata] = await Promise.all([
          stat(selectedRoot),
          stat(mountPoint),
        ]);
        if (rootMetadata.dev === mountMetadata.dev) {
          throw new Error("Unproven — mounted fixture did not produce a different device");
        }
        await writeFile(resolve(mountPoint, "fixture"), "mounted");
        await selectAndRead(selectedRoot);
        const operationResults = await launchAndRead("operations");
        validateProbeResults(operationExpectations, operationResults);
        if ((await readFile(outsideSentinel, "utf8")) !== sentinel) {
          throw new Error("Work confinement gate failed: outside sentinel changed");
        }
        results = operationResults;
        await launchAndRead("revoke-state");
      } catch (error) {
        operationFailure = error;
      } finally {
        if (mounted) {
          try {
            await execFileAsync("/usr/bin/hdiutil", ["detach", mountPoint], {
              timeout: 30_000,
              maxBuffer: 1_048_576,
            });
          } catch {
            operationFailure ??= new Error("Unproven — mounted fixture detach failed");
          }
        }
      }
      if (operationFailure !== undefined) throw operationFailure;
    } else {
      const executable = resolve(appBundle, "Contents/MacOS/OctantWorkConfinementGate");
      const baseline = await exactProcessIdentifiers(executable, "hang");
      const hangingProcess = Bun.spawn([executable, "hang"], {
        env: {
          HOME: process.env.HOME,
          LANG: "C",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          TMPDIR: process.env.TMPDIR,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const exitPromise = hangingProcess.exited;
      await waitForExactProcess(executable, "hang", hangingProcess.pid);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      hangingProcess.kill("SIGTERM");
      const exitedAfterTerm = await Promise.race([
        exitPromise.then(() => true),
        new Promise<false>((resolveDelay) => setTimeout(() => resolveDelay(false), 1_000)),
      ]);
      if (exitedAfterTerm) {
        throw new Error("Work confinement cleanup failed: SIGKILL fallback was not exercised");
      }
      hangingProcess.kill("SIGKILL");
      const drained = await Promise.race([
        exitPromise.then(() => true),
        new Promise<false>((resolveDelay) => setTimeout(() => resolveDelay(false), 5_000)),
      ]);
      if (!drained) {
        throw new Error("Work confinement cleanup failed: owned process did not drain");
      }
      const after = await exactProcessIdentifiers(executable, "hang");
      const clean =
        after.size === baseline.size &&
        [...baseline].every((processIdentifier) => after.has(processIdentifier));
      results = [
        {
          probe: "process-cleanup",
          result: clean ? "clean" : "escaped",
          category: clean ? "None" : "Unavailable",
        },
      ];
      validateProbeResults(EXPECTED_RESULTS.cleanup, results);
    }
    for (const result of results) {
      process.stdout.write(
        `probe=${result.probe} result=${result.result} category=${result.category}\n`,
      );
    }
  } finally {
    if (appBundle !== undefined) {
      await runWithTimeout([launchServicesRegister, "-u", appBundle], 30_000);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) await smokePackagedWorkConfinement();
