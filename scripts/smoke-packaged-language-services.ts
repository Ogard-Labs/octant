import { execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeCodeLanguageDocumentResult,
  decodeCodeLanguageReadResult,
  type CodeLanguageReadResult,
} from "@octant/contracts/code-language";
import { installedArtifactServerStartCommand } from "../packages/cli/src/installedArtifact";
import {
  BUNDLED_LANGUAGE_SERVER_BINARY,
  BUNDLED_LANGUAGE_SERVER_FILES,
  bundledLanguageServerPackage,
  DESKTOP_PACKAGE_IDENTITY,
  linuxPackageDirectoryName,
  resolveDesktopPackageTarget,
} from "./package-desktop";
import { hostHeadlessTarget } from "./package-headless";
import {
  createCodeProject,
  createUnusedProviderThread,
  isRecord,
  registerWindowAuthority,
  type SmokeWindowAuthority,
} from "./packaged-smoke-code-project";
import {
  appOutputContext,
  PACKAGED_SMOKE_SERVER_PORT,
  sanitizedPackagedEnvironment,
  spawnPackagedApplication,
  stagePackagedAppBundle,
} from "./packaged-smoke-process";
import { findNodeModulesAncestor } from "./smoke-headless-install";

// The Code editor's language services from a packaged Octant with no
// development checkout present (docs/design/language-services.md, "Ship the
// binary"). The packaged server is copied, or the headless artifact extracted,
// outside the repository with no node_modules above it. It then serves the
// editor's scenario for a Plan thread: the two-file fixture's cross-file type
// error, the jump to the definition in the other file, and a standard-library
// name read as outside the checkout. The language server it runs must be the
// one the package carries, and stopping the host must stop it.
//
//   bun scripts/smoke-packaged-language-services.ts desktop
//   bun scripts/smoke-packaged-language-services.ts headless [<artifact tarball>]

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export type PackagedLanguageServicesPackage =
  | { readonly kind: "desktop"; readonly platform: "darwin" | "linux"; readonly root: string }
  | { readonly kind: "headless"; readonly root: string };

export interface PackagedServerLaunch {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  /** The bundled language server's package folder inside the package. */
  readonly languageServerPackage: string;
}

/**
 * How the package's own server starts: the desktop app's runtime in Node mode
 * on its bundled server, or the headless artifact's server under the runtime
 * its `octant` command uses, exactly as `octant server run` starts it.
 */
export function packagedServerLaunch(
  packaged: PackagedLanguageServicesPackage,
  target: { readonly platform: string; readonly arch: string },
  headlessRuntime: string,
): PackagedServerLaunch {
  const languageServer = bundledLanguageServerPackage(target);
  if (packaged.kind === "headless") {
    const command = installedArtifactServerStartCommand(packaged.root, headlessRuntime);
    return {
      executable: command.command,
      args: command.args,
      env: command.env ?? {},
      languageServerPackage: join(packaged.root, "node_modules", languageServer),
    };
  }
  const resources =
    packaged.platform === "darwin"
      ? join(packaged.root, "Contents", "Resources")
      : join(packaged.root, "resources");
  const executable =
    packaged.platform === "darwin"
      ? join(packaged.root, "Contents", "MacOS", DESKTOP_PACKAGE_IDENTITY.productName)
      : join(packaged.root, DESKTOP_PACKAGE_IDENTITY.productName);
  return {
    executable,
    args: [join(resources, "app", "apps", "server", "dist", "main.mjs")],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    languageServerPackage: join(resources, "app", "apps", "server", "node_modules", languageServer),
  };
}

/** The slice's two-file fixture: `b.ts` assigns `greet`'s string to a number. */
export const LANGUAGE_FIXTURE: Readonly<Record<string, string>> = {
  "tsconfig.json": `${JSON.stringify({
    compilerOptions: { strict: true, target: "es2022", module: "nodenext", noEmit: true },
    include: ["*.ts"],
  })}\n`,
  "a.ts": 'export function greet(name: string): string {\n  return "hi " + name;\n}\n',
  "b.ts":
    'import { greet } from "./a.js";\nexport const count: number = greet("x");\nexport const most = Math.max(1, 2);\n',
};

/**
 * Everything wrong with the three reads, or nothing when the package served
 * the scenario. Exactly one diagnostic is expected: a server that cannot find
 * its standard library still reports the type error, buried among errors for
 * every missing global type.
 */
export function languageScenarioFailures(answers: {
  readonly diagnostics: CodeLanguageReadResult;
  readonly definition: CodeLanguageReadResult;
  readonly library: CodeLanguageReadResult;
}): ReadonlyArray<string> {
  const failures: string[] = [];
  const { diagnostics, definition, library } = answers;
  if (diagnostics.status !== "diagnostics") {
    failures.push(`diagnostics read answered ${describeAnswer(diagnostics)}`);
  } else {
    const [only, ...rest] = diagnostics.diagnostics;
    if (
      rest.length > 0 ||
      only === undefined ||
      only.path !== "b.ts" ||
      only.severity !== "error" ||
      only.range.start.line !== 1 ||
      only.message !== "Type 'string' is not assignable to type 'number'."
    ) {
      failures.push(
        `diagnostics were not b.ts's one type error: ${JSON.stringify(diagnostics.diagnostics)}`,
      );
    }
  }
  if (definition.status !== "definition") {
    failures.push(`definition read answered ${describeAnswer(definition)}`);
  } else {
    const [target] = definition.targets;
    if (
      definition.targets.length !== 1 ||
      target?.kind !== "checkout-location" ||
      target.path !== "a.ts" ||
      target.range.start.line !== 0
    ) {
      failures.push(`greet's definition was not in a.ts: ${JSON.stringify(definition.targets)}`);
    }
  }
  if (library.status !== "definition") {
    failures.push(`standard-library definition read answered ${describeAnswer(library)}`);
  } else if (
    !library.targets.some(
      (target) => target.kind === "outside-checkout" && target.label === "bundled-library",
    )
  ) {
    failures.push(
      `Math's definition was not the bundled library: ${JSON.stringify(library.targets)}`,
    );
  }
  return failures;
}

function describeAnswer(answer: CodeLanguageReadResult): string {
  return answer.status === "refused" || answer.status === "unavailable"
    ? `${answer.status} (${answer.reason})`
    : answer.status;
}

async function main(): Promise<void> {
  const [kind = "desktop", tarball] = process.argv.slice(2);
  if (kind !== "desktop" && kind !== "headless") {
    throw new Error(
      "Usage: smoke-packaged-language-services.ts desktop | headless [<artifact tarball>]",
    );
  }
  const scratch = await mkdtemp(join(tmpdir(), "octant-language-smoke-"));
  try {
    const packaged =
      kind === "headless"
        ? await extractHeadlessArtifact(tarball ?? newestHeadlessTarball(), scratch)
        : stageDesktopPackage();
    const ancestor = findNodeModulesAncestor(dirname(packaged.root));
    if (ancestor !== undefined) {
      throw new Error(`${ancestor} has a node_modules directory above the package; refusing.`);
    }
    const launch = packagedServerLaunch(packaged, process, process.execPath);
    for (const file of BUNDLED_LANGUAGE_SERVER_FILES) {
      await access(join(launch.languageServerPackage, file));
    }
    const binary = realpathSync(join(launch.languageServerPackage, BUNDLED_LANGUAGE_SERVER_BINARY));
    await serveScenario({ launch, binary, scratch });
    console.log(
      [
        `Packaged ${kind} language services smoke passed from ${packaged.root}:`,
        "  no development checkout or node_modules above the package",
        `  the package carries ${bundledLanguageServerPackage(process)} with its LICENSE and NOTICE.txt`,
        "  a Plan thread read b.ts's cross-file type error, jumped to greet in a.ts, and read Math as the bundled library",
        `  the language server that answered ran from ${binary}`,
        "  stopping the host stopped the language server",
      ].join("\n"),
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function stageDesktopPackage(): PackagedLanguageServicesPackage {
  const target = resolveDesktopPackageTarget(process.env);
  const built =
    target.platform === "darwin"
      ? resolve(repositoryRoot, "out", `${DESKTOP_PACKAGE_IDENTITY.productName}.app`)
      : resolve(repositoryRoot, "out", linuxPackageDirectoryName(target));
  if (!existsSync(built)) {
    throw new Error(`No packaged app at ${built}. Run bun run package:desktop first.`);
  }
  return { kind: "desktop", platform: target.platform, root: stagePackagedAppBundle(built) };
}

function newestHeadlessTarball(): string {
  const target = hostHeadlessTarget();
  if (target === undefined) throw new Error("This host has no headless artifact target.");
  const directory = resolve(repositoryRoot, "out", "headless");
  const suffix = `-${target.platform}-${target.arch}.tar.gz`;
  const newest = (existsSync(directory) ? readdirSync(directory) : [])
    .filter((name) => name.startsWith("octant-") && name.endsWith(suffix))
    .map((name) => join(directory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  if (newest === undefined) {
    throw new Error(`No ${suffix} artifact in out/headless. Run bun scripts/package-headless.ts.`);
  }
  return newest;
}

async function extractHeadlessArtifact(
  tarball: string,
  scratch: string,
): Promise<PackagedLanguageServicesPackage> {
  const extracted = join(scratch, "artifact");
  await mkdir(extracted);
  execFileSync("tar", ["-xzf", tarball, "-C", extracted], { stdio: "ignore" });
  const [name] = await readdir(extracted);
  if (name === undefined) throw new Error("The tarball held no artifact directory.");
  return { kind: "headless", root: join(extracted, name) };
}

async function createFixtureRepository(scratch: string): Promise<string> {
  const repository = join(scratch, "repository");
  await mkdir(repository);
  for (const [name, content] of Object.entries(LANGUAGE_FIXTURE)) {
    await writeFile(join(repository, name), content);
  }
  const gitEnv = { PATH: "/usr/bin:/bin", HOME: repository };
  const git = (args: ReadonlyArray<string>) =>
    execFileSync("git", ["-C", repository, ...args], { env: gitEnv, stdio: "ignore" });
  git(["init", "-q", "-b", "main"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Octant smoke",
    "-c",
    "user.email=smoke@octant.invalid",
    "commit",
    "-q",
    "-m",
    "Fixture",
  ]);
  return realpathSync(repository);
}

async function serveScenario(input: {
  readonly launch: PackagedServerLaunch;
  readonly binary: string;
  readonly scratch: string;
}): Promise<void> {
  const repository = await createFixtureRepository(input.scratch);
  const dataDirectory = join(input.scratch, "data");
  await mkdir(dataDirectory, { mode: 0o700 });
  const desktopBridgeSecret = randomBytes(32).toString("base64url");
  const serverUrl = `http://127.0.0.1:${PACKAGED_SMOKE_SERVER_PORT}`;
  const { child, outputTail } = spawnPackagedApplication({
    executable: input.launch.executable,
    args: input.launch.args,
    env: {
      ...sanitizedPackagedEnvironment(process.env, dataDirectory),
      ...input.launch.env,
      OCTANT_SERVER_PORT: String(PACKAGED_SMOKE_SERVER_PORT),
      OCTANT_DESKTOP_BRIDGE_SECRET: desktopBridgeSecret,
    },
  });
  try {
    await waitForStorageReady(serverUrl, outputTail);
    const window = await registerWindowAuthority(serverUrl, desktopBridgeSecret);
    const project = await createCodeProject({
      serverUrl,
      desktopBridgeSecret,
      window,
      repository,
      name: "Packaged language services smoke",
    });
    const threadId = await createUnusedProviderThread({
      window,
      project,
      title: "Packaged language services smoke",
      executionPolicy: "plan",
    });
    const scope = { threadId, checkoutId: project.checkoutId };
    const opened = decodeCodeLanguageDocumentResult(
      await window.send(
        "/api/code/language/documents",
        { kind: "open", ...scope, path: "b.ts", text: LANGUAGE_FIXTURE["b.ts"] },
        "open b.ts for language services",
      ),
    );
    if (opened.status !== "synced") {
      throw new Error(`Opening b.ts answered ${JSON.stringify(opened)}.`);
    }
    const file = { ...scope, fileId: opened.fileId };
    const diagnostics = await readSettled(window, { kind: "diagnostics", ...file });
    if (!processListing().includes(input.binary)) {
      throw new Error(`No process runs the packaged language server ${input.binary}.`);
    }
    const definition = await readSettled(window, {
      kind: "definition",
      ...file,
      position: { line: 1, character: 30 },
    });
    const library = await readSettled(window, {
      kind: "definition",
      ...file,
      position: { line: 2, character: 25 },
    });
    const failures = languageScenarioFailures({ diagnostics, definition, library });
    if (failures.length > 0) throw new Error(failures.join("\n"));
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${appOutputContext(outputTail)}`,
    );
  } finally {
    await stopServer(child);
  }
  // Host shutdown stops every language server it started.
  const deadline = Date.now() + 10_000;
  while (processListing().includes(input.binary)) {
    if (Date.now() > deadline) {
      throw new Error("The packaged language server outlived its host.");
    }
    await sleep(100);
  }
}

/** A read, asked again while the server is still starting, as the editor does. */
async function readSettled(
  window: SmokeWindowAuthority,
  request: Readonly<Record<string, unknown>>,
): Promise<CodeLanguageReadResult> {
  const deadline = Date.now() + 30_000;
  while (true) {
    const answer = decodeCodeLanguageReadResult(
      await window.send("/api/code/language/read", request, `read ${String(request.kind)}`),
    );
    const starting = answer.status === "unavailable" && answer.reason === "starting";
    if (!starting || Date.now() > deadline) return answer;
    await sleep(250);
  }
}

async function waitForStorageReady(serverUrl: string, outputTail: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(500) });
      const body: unknown = await response.json();
      if (response.ok && isRecord(body) && body.status === "ok" && body.storage === "ready") {
        return;
      }
    } catch {
      // Still binding, or already gone; the output tail says which.
    }
    await sleep(100);
  }
  throw new Error(`The packaged server was not storage-ready.${appOutputContext(outputTail)}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  const signal = (name: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-pid, name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  const timedOut = await Promise.race([exited.then(() => false), sleep(10_000).then(() => true)]);
  if (timedOut) {
    signal("SIGKILL");
    await exited;
  }
}

function processListing(): string {
  return execFileSync("/bin/ps", ["-ax", "-o", "command="], { encoding: "utf8" });
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
