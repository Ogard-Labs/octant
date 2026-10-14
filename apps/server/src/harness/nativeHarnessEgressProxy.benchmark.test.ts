import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect } from "node:net";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startToolEgressProxy, type ToolEgressProxy } from "./nativeHarnessEgressProxy";
import { launchFor, threadRule } from "./nativeHarnessEgressProxy.test-support";

/*
 * The phase budget for the harness tool egress proxy: a clone and a package
 * install against a local fixture origin stay within 10% of the direct path.
 * Each proxied run starts a fresh proxy for the command, as a launch would,
 * so the listener bind, token, and records are inside the measurement.
 * Origins are loopback fixtures; names reach them through the proxy's
 * injected resolver and dialer, so nothing leaves this machine.
 *
 * Opt-in, because wall-clock budgets do not belong in the default suite:
 *   bun run egress-proxy:benchmark   (in apps/server)
 */

const enabled = process.env.OCTANT_RUN_EGRESS_PROXY_BENCHMARK === "1";
const BUDGET = 1.1;
const RUNS = Number(process.env.OCTANT_EGRESS_PROXY_BENCHMARK_RUNS ?? "9");
const ORIGIN_ADDRESS = "203.0.113.20";

const root = enabled ? realpathSync(mkdtempSync(join(tmpdir(), "octant-egress-bench-"))) : "";
const closers: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const close of closers.splice(0)) await close();
  if (root.length > 0) rmSync(root, { recursive: true, force: true });
});

interface Scenario {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly direct: (run: string) => Command;
  readonly proxied: (run: string) => Command;
}

interface Command {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

describe.skipIf(!enabled)("native harness tool egress proxy benchmark", () => {
  it("keeps a clone and a package install within 10% of the direct path", async () => {
    const certificate = makeCertificate();
    const baseEnv = isolatedEnvironment();
    const repository = makeBareRepository();
    const registry = makeRegistry();

    const gitHttps = await serve("https", certificate, staticFiles(repository));
    const gitHttp = await serve("http", certificate, staticFiles(repository));
    const npmHttps = await serve("https", certificate, registry.handle);

    const scenarios: ReadonlyArray<Scenario> = [
      {
        name: "git clone over HTTPS (CONNECT)",
        host: "git.example.com",
        port: gitHttps,
        direct: (run) =>
          gitClone(`https://127.0.0.1:${String(gitHttps)}/repo.git`, run, baseEnv, certificate),
        proxied: (run) =>
          gitClone(
            `https://git.example.com:${String(gitHttps)}/repo.git`,
            run,
            baseEnv,
            certificate,
          ),
      },
      {
        name: "git clone over plain HTTP (forwarded)",
        host: "git.example.com",
        port: gitHttp,
        direct: (run) =>
          gitClone(`http://127.0.0.1:${String(gitHttp)}/repo.git`, run, baseEnv, certificate),
        proxied: (run) =>
          gitClone(`http://git.example.com:${String(gitHttp)}/repo.git`, run, baseEnv, certificate),
      },
      {
        name: "npm install over HTTPS (CONNECT)",
        host: "registry.example.com",
        port: npmHttps,
        direct: (run) =>
          npmInstall(
            `https://127.0.0.1:${String(npmHttps)}/`,
            run,
            baseEnv,
            certificate,
            registry.names,
          ),
        proxied: (run) =>
          npmInstall(
            `https://registry.example.com:${String(npmHttps)}/`,
            run,
            baseEnv,
            certificate,
            registry.names,
          ),
      },
    ];

    const rows: string[] = [];
    const failures: string[] = [];
    for (const scenario of scenarios) {
      // One unmeasured run of each warms the page cache and the tools themselves.
      await runDirect(scenario, "warm-direct");
      await runProxied(scenario, "warm-proxied");
      const direct: number[] = [];
      const proxied: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        direct.push(await runDirect(scenario, `direct-${String(run)}`));
        proxied.push(await runProxied(scenario, `proxied-${String(run)}`));
      }
      const ratio = median(proxied) / median(direct);
      // Runs alternate, so each pair shares the machine's load at that moment.
      const paired = median(proxied.map((value, index) => value / (direct[index] ?? value)));
      rows.push(
        [
          `${scenario.name}:`,
          `median direct ${median(direct).toFixed(0)} ms, proxied ${median(proxied).toFixed(0)} ms, ratio ${ratio.toFixed(3)};`,
          `median paired ratio ${paired.toFixed(3)};`,
          `fastest direct ${Math.min(...direct).toFixed(0)} ms, proxied ${Math.min(...proxied).toFixed(0)} ms`,
          `(runs ${String(RUNS)}; direct ${direct.map((value) => value.toFixed(0)).join("/")}; proxied ${proxied.map((value) => value.toFixed(0)).join("/")})`,
        ].join(" "),
      );
      if (ratio > BUDGET) failures.push(scenario.name);
    }
    const machine = `${cpus()[0]?.model ?? "unknown cpu"} x${String(cpus().length)}, ${process.platform} ${process.arch}, node ${process.version}, load ${loadavg()
      .map((value) => value.toFixed(2))
      .join(" ")}`;
    process.stdout.write(`${["egress proxy benchmark", machine, ...rows].join("\n")}\n`);
    expect(failures).toEqual([]);
  });
});

async function runDirect(scenario: Scenario, run: string): Promise<number> {
  const started = performance.now();
  await execute(scenario.direct(run));
  return performance.now() - started;
}

async function runProxied(scenario: Scenario, run: string): Promise<number> {
  const started = performance.now();
  const proxy = await startProxy(scenario.host, scenario.port);
  const command = scenario.proxied(run);
  await execute({ ...command, env: { ...command.env, ...proxyEnvironment(proxy) } });
  const closed = await proxy.close();
  const elapsed = performance.now() - started;
  // A run that did not go through the proxy measures nothing.
  if (closed.status !== "summarized" || closed.summary.bytesReceived === 0) {
    throw new Error(`${scenario.name} did not use the proxy`);
  }
  // Git's libcurl asks without credentials first and answers the 407; that
  // one token refusal per launch is the client's handshake, not a failure.
  if (
    closed.summary.entries.some((entry) => entry.decision === "refused" && entry.reason !== "token")
  ) {
    throw new Error(`${scenario.name} was refused: ${JSON.stringify(closed.summary.entries)}`);
  }
  return elapsed;
}

async function startProxy(host: string, port: number): Promise<ToolEgressProxy> {
  const rules = [
    threadRule(host, port, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
  ];
  const started = await startToolEgressProxy({
    launch: launchFor(),
    taint: () => ({ threadTainted: false, parentTainted: false }),
    rules: () => rules,
    clock: () => new Date().toISOString(),
    endpoint: { kind: "loopback" },
    resolveAll: async () => [ORIGIN_ADDRESS],
    connect: ({ address }) => {
      if (address !== ORIGIN_ADDRESS) throw new Error(`unexpected address ${address}`);
      return netConnect({ host: "127.0.0.1", port, allowHalfOpen: true });
    },
    records: {
      launchStarted: async () => ({ status: "appended" }),
      decisionsRecorded: async () => ({ status: "appended" }),
      launchSummarized: async () => ({ status: "appended" }),
    },
  });
  if (started.status !== "listening") throw new Error(`proxy refused: ${started.reason}`);
  return started.proxy;
}

/** The variables the design gives a `proxied` launch. */
function proxyEnvironment(proxy: ToolEgressProxy): NodeJS.ProcessEnv {
  const endpoint = proxy.endpoint;
  if (endpoint.kind !== "loopback") throw new Error("expected a loopback endpoint");
  const url = `http://octant:${proxy.token}@127.0.0.1:${String(endpoint.port)}`;
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    ALL_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    all_proxy: url,
    NO_PROXY: "",
    no_proxy: "",
    NODE_USE_ENV_PROXY: "1",
  };
}

function gitClone(
  url: string,
  run: string,
  env: NodeJS.ProcessEnv,
  certificate: Certificate,
): Command {
  const destination = join(root, "clones", run);
  rmSync(destination, { recursive: true, force: true });
  return {
    file: "git",
    args: ["clone", "--quiet", url, destination],
    env: { ...env, GIT_SSL_CAINFO: certificate.certPath },
  };
}

function npmInstall(
  registry: string,
  run: string,
  env: NodeJS.ProcessEnv,
  certificate: Certificate,
  names: ReadonlyArray<string>,
): Command {
  const project = join(root, "installs", run);
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "bench-project",
      version: "1.0.0",
      private: true,
      dependencies: Object.fromEntries(names.map((name) => [name, "1.0.0"])),
    }),
  );
  return {
    file: "npm",
    args: [
      "install",
      "--prefix",
      project,
      "--registry",
      registry,
      "--cafile",
      certificate.certPath,
      "--cache",
      join(root, "npm-cache", run),
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--ignore-scripts",
      "--prefer-online",
      "--loglevel",
      "error",
    ],
    env,
  };
}

function execute(command: Command): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.args], {
      env: command.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    // A stalled command is a finding, not a slow sample.
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command.file} ${command.args.join(" ")} ended ${String(code ?? signal)}: ${errors}`,
          ),
        );
    });
  });
}

/** No user or system configuration from this machine leaks into a run. */
function isolatedEnvironment(): NodeJS.ProcessEnv {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".npmrc"), "");
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_update_notifier: "false",
  };
}

interface Certificate {
  readonly certPath: string;
  readonly cert: Buffer;
  readonly key: Buffer;
}

function makeCertificate(): Certificate {
  const keyPath = join(root, "key.pem");
  const certPath = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "2",
      "-subj",
      "/CN=octant-egress-bench",
      "-addext",
      "subjectAltName=DNS:git.example.com,DNS:registry.example.com,DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { certPath, cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

/** A packed bare repository of about 10 MB, served as static files (Git's dumb HTTP). */
function makeBareRepository(): string {
  const work = join(root, "repo-work");
  mkdirSync(work, { recursive: true });
  for (let index = 0; index < 300; index += 1) {
    writeFileSync(join(work, `file-${String(index)}.bin`), randomBytes(32 * 1_024));
  }
  const git = (args: ReadonlyArray<string>, cwd: string) =>
    execFileSync("git", [...args], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      env: isolatedEnvironment(),
    });
  git(["init", "--quiet", "--initial-branch=main"], work);
  git(["add", "."], work);
  git(
    [
      "-c",
      "user.name=bench",
      "-c",
      "user.email=bench@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    work,
  );
  const bare = join(root, "repo.git");
  git(["clone", "--quiet", "--bare", work, bare], root);
  git(["repack", "-a", "-d", "--quiet"], bare);
  git(["update-server-info"], bare);
  return bare;
}

/** Forty packages of 64 KB each, with packuments naming tarballs on whichever host was asked. */
function makeRegistry(): {
  readonly names: ReadonlyArray<string>;
  readonly handle: (request: IncomingMessage, response: ServerResponse) => void;
} {
  const names = Array.from({ length: 40 }, (_, index) => `bench-package-${String(index)}`);
  const tarballs = new Map<string, Buffer>();
  for (const name of names) {
    const directory = join(root, "packages", name, "package");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    writeFileSync(join(directory, "payload.bin"), randomBytes(64 * 1_024));
    const tarball = join(root, "packages", `${name}.tgz`);
    execFileSync("tar", ["-czf", tarball, "-C", join(root, "packages", name), "package"]);
    tarballs.set(name, readFileSync(tarball));
  }
  return {
    names,
    handle: (request, response) => {
      const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      const host = request.headers.host ?? "localhost";
      const tarballMatch = /^\/([^/]+)\/-\/[^/]+\.tgz$/.exec(path);
      if (tarballMatch !== null) {
        const tarball = tarballs.get(tarballMatch[1] ?? "");
        if (tarball === undefined) return notFound(response);
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": tarball.length,
        });
        response.end(tarball);
        return;
      }
      const name = path.slice(1);
      const tarball = tarballs.get(name);
      if (tarball === undefined) return notFound(response);
      const body = JSON.stringify({
        name,
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name,
            version: "1.0.0",
            dist: {
              tarball: `https://${host}/${name}/-/${name}-1.0.0.tgz`,
              shasum: createHash("sha1").update(tarball).digest("hex"),
              integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
            },
          },
        },
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
    },
  };
}

function staticFiles(
  directory: string,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    if (!path.startsWith("/repo.git/")) return notFound(response);
    const file = normalize(join(directory, path.slice("/repo.git/".length)));
    if (!file.startsWith(directory)) return notFound(response);
    try {
      if (!statSync(file).isFile()) return notFound(response);
      const body = readFileSync(file);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": body.length,
      });
      response.end(body);
    } catch {
      notFound(response);
    }
  };
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { "content-length": 0 });
  response.end();
}

async function serve(
  scheme: "http" | "https",
  certificate: Certificate,
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<number> {
  const server =
    scheme === "https"
      ? createHttpsServer({ cert: certificate.cert, key: certificate.key }, handle)
      : createHttpServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
