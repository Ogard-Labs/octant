// Runs the Windows confinement launcher for real on a hosted Windows runner:
// the server's own port prepares each launch, and the native launcher applies
// it. It proves the AppContainer, ACL and job mechanism on that runner only (an
// administrator account); it runs no provider and lifts no Windows refusal.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  makeProcessConfinementLive,
  type ProcessConfinementPrepareInput,
} from "../apps/server/src/process/seatbeltProfile";

if (process.platform !== "win32")
  throw new Error("Confinement acceptance requires native Windows.");
const launcherPath = resolve(process.argv[2] ?? "");
if (!launcherPath.endsWith("octant-windows-confine.exe"))
  throw new Error("Supply the owned native launcher build.");

const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const cmd = join(system32, "cmd.exe");
const curl = join(system32, "curl.exe");
// The long-name form: a runner's temp folder can arrive as an 8.3 short name.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "octant-confine-")));
const home = realpathSync.native(homedir());
const granted = join(root, "granted");
const readOnly = join(root, "read-only");
const outside = join(root, "outside");
const temporary = join(root, "tmp");
const store = join(root, "store");
for (const folder of [granted, join(store, "profile"), readOnly, outside, temporary]) {
  mkdirSync(folder, { recursive: true });
}
writeFileSync(join(granted, "inside.txt"), "inside-content");
writeFileSync(join(store, "profile", "Cookies"), "cookie-content");
writeFileSync(join(readOnly, "readable.txt"), "readable-content");
writeFileSync(join(outside, "secret.txt"), "outside-secret");
// cmd.exe does not read the backslash-escaped quotes Windows argument
// quoting writes inside one argument, so the fixture paths carry no spaces
// and the command lines name them unquoted.
if (/\s/u.test(root) || /\s/u.test(home)) throw new Error("Fixture paths must not contain spaces.");
const homeFile = join(home, `octant-confine-smoke-${randomBytes(6).toString("hex")}.txt`);
writeFileSync(homeFile, "home-secret");

const port = makeProcessConfinementLive({
  platform: "win32",
  unverifiedWindowsConfinement: { launcherPath, homeDirectory: home },
});

function prepare(
  executable: string,
  args: ReadonlyArray<string>,
  overrides: Partial<ProcessConfinementPrepareInput> = {},
) {
  return port.prepare({
    executable,
    args,
    boundRoot: granted,
    temporaryDirectory: temporary,
    readRoots: [readOnly],
    networkEgress: "none",
    ...overrides,
  });
}

function run(
  executable: string,
  args: ReadonlyArray<string>,
  overrides: Partial<ProcessConfinementPrepareInput> = {},
) {
  const launch = prepare(executable, args, overrides);
  const result = spawnSync(launch.command, [...launch.args], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const results: Array<{ check: string; passed: boolean; detail: string }> = [];
function check(name: string, passed: boolean, detail: unknown) {
  results.push({ check: name, passed, detail: JSON.stringify(detail) });
}

const shell = (line: string) => ["/d", "/c", line];
// A refusal counts only when Windows says access was denied: a syntax error
// or a missing file also exits non-zero and proves nothing.
const accessDenied = (result: { readonly stderr: string }) =>
  /Access is denied/iu.test(result.stderr);

try {
  const exit = run(cmd, shell("exit 7"));
  check("relays the command's exit code", exit.status === 7, exit);

  const inside = run(cmd, shell(`type ${join(granted, "inside.txt")}`));
  check(
    "reads inside the bound root",
    inside.status === 0 && inside.stdout.includes("inside-content"),
    inside,
  );

  const readable = run(cmd, shell(`type ${join(readOnly, "readable.txt")}`));
  check(
    "reads a read root",
    readable.status === 0 && readable.stdout.includes("readable-content"),
    readable,
  );

  const write = run(cmd, shell(`echo written> ${join(granted, "written.txt")}`));
  check(
    "writes inside the bound root",
    write.status === 0 && existsSync(join(granted, "written.txt")),
    write,
  );

  const readOnlyWrite = run(cmd, shell(`echo refused> ${join(readOnly, "refused.txt")}`));
  check(
    "refuses a write to a read root",
    readOnlyWrite.status !== 0 &&
      accessDenied(readOnlyWrite) &&
      !existsSync(join(readOnly, "refused.txt")),
    readOnlyWrite,
  );

  const outsideRead = run(cmd, shell(`type ${join(outside, "secret.txt")}`));
  check(
    "refuses a folder it was not granted",
    outsideRead.status !== 0 &&
      accessDenied(outsideRead) &&
      !outsideRead.stdout.includes("outside-secret"),
    outsideRead,
  );

  const homeRead = run(cmd, shell(`type ${homeFile}`));
  check(
    "refuses a file in the person's home folder",
    homeRead.status !== 0 && accessDenied(homeRead) && !homeRead.stdout.includes("home-secret"),
    homeRead,
  );

  // A deny entry cannot carve a file out of a grant (measured here: the
  // container still read it), so the port must refuse to grant a folder that
  // already holds a browser store, before the launcher runs at all.
  let storeRefusal = "";
  try {
    prepare(cmd, shell("exit 0"), { readRoots: [readOnly, store] });
  } catch (error) {
    storeRefusal = error instanceof Error ? error.message : String(error);
  }
  check(
    "refuses to grant a folder that holds a browser store",
    /holds .*Cookies/u.test(storeRefusal),
    storeRefusal,
  );

  // A grant whose path runs through a junction would land on the junction's
  // target, which the plan judged under another name: the launcher refuses.
  const alias = join(root, "alias");
  mkdirSync(join(outside, "inner"), { recursive: true });
  const junction = spawnSync(cmd, ["/d", "/c", "mklink", "/J", alias, outside], {
    encoding: "utf8",
  });
  const throughJunction = run(cmd, shell("exit 0"), {
    readRoots: [readOnly, join(alias, "inner")],
  });
  const innerAfter = spawnSync("icacls", [join(outside, "inner")], { encoding: "utf8" });
  check(
    "refuses a grant whose path passes through a junction",
    junction.status === 0 &&
      throughJunction.status === 125 &&
      /passes through a junction or link/u.test(throughJunction.stderr) &&
      !/S-1-15-2-\d+-\d+/u.test(innerAfter.stdout),
    { junction: junction.stdout, throughJunction, inner: innerAfter.stdout },
  );

  const nested = run(cmd, shell("cmd /d /c echo nested-ran"));
  check(
    "lets a launch that may create processes start a child",
    nested.stdout.includes("nested-ran"),
    nested,
  );
  const noChild = run(cmd, shell("cmd /d /c echo nested-ran"), { allowProcessFork: false });
  check(
    "refuses a child to a launch that may create no process",
    !noChild.stdout.includes("nested-ran") && /quota/iu.test(noChild.stderr),
    noChild,
  );

  // The same program, the same request and the same output file differ only
  // in the capability: curl writes its body into the granted temporary
  // directory, since the container may not open every device a host may.
  const fetch = (into: string) => [
    "-s",
    "-S",
    "-m",
    "20",
    "-o",
    join(temporary, into),
    "https://example.com",
  ];
  const offline = run(curl, fetch("offline.html"));
  // 6 is curl's "could not resolve host", 7 "could not connect": the request
  // never left the container. Any other failure proves nothing about policy.
  check(
    "reaches no network with no capability",
    (offline.status === 6 || offline.status === 7) && !existsSync(join(temporary, "offline.html")),
    offline,
  );
  const online = run(curl, fetch("online.html"), { networkEgress: "allow" });
  check(
    "reaches the internet with the client capability",
    online.status === 0 && existsSync(join(temporary, "online.html")),
    online,
  );

  const grantVisible = run(cmd, shell(`icacls ${granted}`));
  check(
    "names the container in the bound root's DACL while it runs",
    /Octant\.Confined\.|S-1-15-2-\d+-\d+/u.test(grantVisible.stdout),
    grantVisible,
  );
  const afterwards = spawnSync("icacls", [granted], { encoding: "utf8" });
  check(
    "removes the container's ACE when the command ends",
    afterwards.status === 0 && !/Octant\.Confined\.|S-1-15-2-\d+-\d+/u.test(afterwards.stdout),
    afterwards.stdout,
  );

  // Two launches on the same checkout at once each write the whole DACL; the
  // launcher's session lock must keep both entries while both run, and each
  // launch's cleanup must remove its own entry and not the other's.
  const containerSids = () => {
    const listing = spawnSync("icacls", [granted], { encoding: "utf8" }).stdout;
    return new Set(listing.match(/S-1-15-2(?:-\d+){7}/gu) ?? []);
  };
  const waiting = [0, 1].map(() => {
    const launch = prepare(cmd, shell("set /p OCTANT_WAIT= & echo released"));
    return spawn(launch.command, [...launch.args], { stdio: ["pipe", "pipe", "pipe"] });
  });
  const outputs = waiting.map((child) => {
    const output = { stdout: "", stderr: "" };
    child.stdout.on("data", (chunk: Buffer) => (output.stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output.stderr += chunk.toString()));
    return output;
  });
  const exits = waiting.map(
    (child) => new Promise<number | null>((done) => child.on("close", (code) => done(code))),
  );
  let concurrent = 0;
  for (let attempt = 0; attempt < 60 && concurrent < 2; attempt += 1) {
    await new Promise((done) => setTimeout(done, 500));
    concurrent = containerSids().size;
  }
  // `set /p` exits 1 on an empty line, so each launch is released with a word.
  // (cmd expands `%VAR%` when it parses the line, before `set /p` runs, so
  // the echo names no variable.)
  for (const child of waiting) child.stdin.end("go\r\n");
  const codes = await Promise.all(exits);
  const leftAfter = containerSids().size;
  check(
    "keeps both grants while two launches share a checkout and removes both after",
    concurrent === 2 &&
      codes.every((code) => code === 0) &&
      outputs.every((output) => output.stdout.includes("released")) &&
      leftAfter === 0,
    { concurrent, codes, outputs, leftAfter },
  );

  const marker = `octant-confine-${randomBytes(6).toString("hex")}`;
  const held = prepare(cmd, ["/d", "/c", "cmd", "/d", "/c", `set /p OCTANT_WAIT= & rem ${marker}`]);
  const launcher = spawn(held.command, [...held.args], { stdio: ["pipe", "ignore", "ignore"] });
  const markedProcesses = () =>
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `@(Get-CimInstance Win32_Process -Filter "Name='cmd.exe' AND CommandLine LIKE '%${marker}%'").Count`,
      ],
      { encoding: "utf8" },
    ).stdout.trim();
  let started = "0";
  for (let attempt = 0; attempt < 30 && started === "0"; attempt += 1) {
    await new Promise((done) => setTimeout(done, 500));
    started = markedProcesses();
  }
  launcher.kill();
  let remaining = started;
  for (let attempt = 0; attempt < 20 && remaining !== "0"; attempt += 1) {
    await new Promise((done) => setTimeout(done, 500));
    remaining = markedProcesses();
  }
  check(
    "ends the command's whole process tree when the launcher is killed",
    started !== "0" && remaining === "0",
    { started, remaining },
  );
} finally {
  rmSync(homeFile, { force: true });
  rmSync(root, { recursive: true, force: true });
}

for (const result of results) {
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.check}: ${result.detail}`);
}
if (results.some((result) => !result.passed)) process.exit(1);
