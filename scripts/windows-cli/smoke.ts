// Drives the real `octant` CLI on a Windows machine through the per-user
// service lifecycle and asserts each step's actual effect, not only its exit
// code. It expects the native host binding and credential helper in the
// `native` folder beside the checkout, where the CLI and the server it starts
// both load them from a source run.
import { execFile, spawn } from "node:child_process";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWindowsCliServiceManager,
  createWindowsHostOwnerPort,
  openWindowsCliHost,
} from "../../packages/cli/src/windowsHost";

if (process.platform !== "win32") throw new Error("This smoke runs on Windows only.");
const checkout = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = win32.join(checkout, "packages", "cli", "src", "bin.ts");
const system32 = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const checks: string[] = [];
const environment: Record<string, string | undefined> = { ...process.env };
for (const key of ["OCTANT_DATA_DIR", "OCTANT_LOGS_DIR"]) delete environment[key];

function check(value: boolean, name: string, detail = ""): void {
  if (!value) throw new Error(`Windows CLI smoke failed: ${name}${detail ? `\n${detail}` : ""}`);
  checks.push(name);
  console.log(`ok - ${name}`);
}

function run(
  command: string,
  args: readonly string[],
  timeoutMs = 90_000,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (bytes: Buffer) => (stdout += bytes.toString("utf8")));
    child.stderr.on("data", (bytes: Buffer) => (stderr += bytes.toString("utf8")));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", reject);
    // `exit`, not `close`: a detached host inherits no pipes, but wait for
    // the command itself only.
    child.once("exit", (code) => {
      clearTimeout(timer);
      setTimeout(() => resolve({ code: code ?? -1, stdout, stderr }), 100);
    });
  });
}

const octant = (...args: string[]) => run(process.execPath, [cliEntry, ...args]);

async function runValue(): Promise<string | undefined> {
  const result = await run(win32.join(system32, "reg.exe"), ["query", runKey, "/v", "Octant"]);
  if (result.code !== 0) return undefined;
  return /^\s+Octant\s+REG_SZ\s+(.+?)\s*$/m.exec(result.stdout)?.[1];
}

async function descendants(pid: number): Promise<readonly number[]> {
  // Test-side process listing only; the product never runs PowerShell.
  const result = await new Promise<string>((resolve, reject) =>
    execFile(
      win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$all = Get-CimInstance Win32_Process; $found = @(${pid}); $queue = @(${pid}); while ($queue.Count) { $next = @(); foreach ($p in $queue) { $next += @($all | Where-Object { $_.ParentProcessId -eq $p } | ForEach-Object { $_.ProcessId }) }; $found += $next; $queue = $next }; $found -join ','`,
      ],
      { windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
  return result
    .trim()
    .split(",")
    .filter((value) => value !== "")
    .map(Number);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const host = openWindowsCliHost({ env: environment });
if (host.status !== "ready") throw new Error(`The CLI could not open its host: ${host.message}`);
const local = process.env.LOCALAPPDATA ?? "";
const root = win32.join(local, "Octant", "hosts", "octant");
check(
  host.paths.rootDirectory.toLowerCase() === root.toLowerCase() &&
    host.paths.dataDirectory === win32.join(host.paths.rootDirectory, "data") &&
    host.paths.configDirectory === win32.join(host.paths.rootDirectory, "config") &&
    host.paths.stateDirectory === win32.join(host.paths.rootDirectory, "state") &&
    host.paths.logsDirectory === win32.join(host.paths.rootDirectory, "logs"),
  "the CLI resolves the desktop app's native profile under %LOCALAPPDATA%\\Octant\\hosts\\octant",
  JSON.stringify(host.paths),
);
const refused = await new Promise<number>((resolve) => {
  const child = spawn(process.execPath, [cliEntry, "server", "status"], {
    env: { ...environment, OCTANT_DATA_DIR: win32.join(local, "elsewhere") },
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("exit", (code) => resolve(code ?? -1));
});
check(refused === 1, "a data folder override is refused on Windows");
const owner = createWindowsHostOwnerPort(host);
check((await owner.observe()).status === "absent", "no host owns the profile before the smoke");

let ownerPid: number | undefined;
try {
  const started = await octant("server", "start");
  check(
    started.code === 0 &&
      /Octant server service: ready/.test(started.stdout) &&
      /Manager: run-key \(active\)/.test(started.stdout),
    "`octant server start` reports the authenticated owner ready under the logon entry",
    `${started.stdout}\n${started.stderr}`,
  );
  const expected = `"${process.execPath}" "${cliEntry}" "server" "start"`;
  check(
    (await runValue()) === expected,
    "the Run value records exactly the CLI's own quoted `server start`",
    String(await runValue()),
  );
  const observed = await owner.observe();
  check(observed.status === "running", "the native pipe authenticates the started owner");
  ownerPid = observed.status === "running" ? observed.pid : undefined;
  const receipt = await host.startup.readHostInfo();
  check(receipt !== undefined, "the host publishes its loopback address in the native profile");
  const health = await fetch(new URL("/health", receipt?.url), {
    signal: AbortSignal.timeout(5_000),
  });
  const body: unknown = await health.json();
  check(
    health.ok &&
      typeof body === "object" &&
      body !== null &&
      "storage" in body &&
      body.storage === "ready",
    "the host answers /health with its storage ready",
    JSON.stringify(body),
  );
  const web = await octant("web", "--no-open");
  check(
    web.code === 0 &&
      /Octant web client ready at http:\/\/127\.0\.0\.1:\d+\/\?serverUrl=.*#launchToken=[A-Za-z0-9_-]+/.test(
        web.stdout,
      ),
    "`octant web --no-open` mints a one-time launch link from the native bridge secret",
    `${web.stdout}\n${web.stderr}`,
  );
  const status = await octant("server", "status");
  check(
    status.code === 0 &&
      /Octant server service: ready/.test(status.stdout) &&
      /Store: current/.test(status.stdout),
    "`octant server status` reads the owner's diagnostics over the pipe",
    status.stdout,
  );
  const logs = await octant("server", "logs");
  check(
    logs.code === 0 && /server\.ready/.test(logs.stdout),
    "`octant server logs` reads the host's native service log",
    logs.stdout,
  );
  const tree = ownerPid === undefined ? [] : await descendants(ownerPid);
  console.log(`host process tree before stop: ${tree.join(", ")}`);
  const stopped = await octant("server", "stop");
  check(
    stopped.code === 0 && /Octant server service: stopped/.test(stopped.stdout),
    "`octant server stop` reports the service stopped",
    `${stopped.stdout}\n${stopped.stderr}`,
  );
  check((await owner.observe()).status === "absent", "the native lookup proves the owner gone");
  check(
    tree.length > 0 && tree.every((pid) => !alive(pid)),
    "no process of the host's tree is left running",
    tree.filter(alive).join(", "),
  );
  check(
    (await host.startup.readHostInfo()) === undefined,
    "the stopped host cleared its published address",
  );

  const disabled = await octant("server", "disable");
  check(
    disabled.code === 0 &&
      /Octant server service: disabled/.test(disabled.stdout) &&
      (await runValue()) === undefined,
    "`octant server disable` removes the logon entry",
    disabled.stdout,
  );
  const enabled = await octant("server", "enable");
  check(
    enabled.code === 0 && (await runValue()) === expected,
    "`octant server enable` records the logon entry again",
    enabled.stdout,
  );

  // Uninstall is the manager's own operation (the desktop app calls it); it
  // must stop a running host and leave no logon entry behind.
  const restarted = await octant("server", "start");
  check(restarted.code === 0, "the host starts again", restarted.stdout);
  const again = await owner.observe();
  ownerPid = again.status === "running" ? again.pid : undefined;
  const manager = createWindowsCliServiceManager(host, { env: environment });
  await manager.uninstall();
  const after = await manager.status();
  check(
    !after.installed && !after.active && (await runValue()) === undefined,
    "uninstall stops the host and removes the logon entry",
    JSON.stringify(after),
  );
  check(ownerPid !== undefined && !alive(ownerPid), "the uninstalled host process has exited");
  console.log(JSON.stringify({ windowsCliSmoke: "passed", checks: checks.length }));
} finally {
  const leftover = await owner.observe();
  if (leftover.status !== "absent") await octant("server", "stop").catch(() => undefined);
  await run(win32.join(system32, "reg.exe"), ["delete", runKey, "/v", "Octant", "/f"]).catch(
    () => undefined,
  );
}
