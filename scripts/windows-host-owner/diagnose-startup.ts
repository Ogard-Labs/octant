import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Owned CI artifact only. Remove this instrumentation before acceptance execution.
const directory = process.argv[2];
if (!directory) throw Error("Supply the owned diagnostic build directory.");
const modules = (await readdir(directory)).filter((name) => /^[A-Za-z0-9_-]+\.mjs$/.test(name));
const chunks = modules.filter((name) => name.startsWith("windowsForeground-"));
if (chunks.length !== 1 || chunks[0] === undefined)
  throw Error("Expected one owned Windows startup chunk.");
const path = join(directory, chunks[0]);
const source = await readFile(path, "utf8");
const marker =
  "console.error(fatalStartupOutput(new WindowsForegroundStartupFailed(phase, failure)));";
if (source.split(marker).length !== 2) throw Error("The owned startup diagnostic point changed.");
const instrumentation = `
for (const candidate of [failure, failure?.cause]) {
  if (candidate === null || typeof candidate !== "object") continue;
  const allowedNames = new Set(["Error", "TypeError", "RangeError", "SqliteError", "ProcessConfinementError", "HostRuntimePathError", "ProviderDriverConfigurationError", "ServerStartupFailed", "PersistenceStartupFailed", "ParseError"]);
  const allowedCodes = new Set(["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "ERR_UNSUPPORTED_PLATFORM", "ENOENT", "EACCES", "EPERM", "EINVAL", "SQLITE_ERROR", "SQLITE_CONSTRAINT", "SQLITE_MISUSE"]);
  const allowedModules = new Set(${JSON.stringify(modules)});
  const frames = typeof candidate.stack === "string" ? [...candidate.stack.matchAll(/([A-Za-z0-9_-]+\\.mjs):([0-9]+):([0-9]+)/g)].filter((match) => allowedModules.has(match[1])).slice(0, 6).map((match) => ({ module: match[1], line: Number(match[2]), column: Number(match[3]) })) : [];
  console.error(JSON.stringify({ ownedFixtureStartupCause: { instrumented: true, name: allowedNames.has(candidate.name) ? candidate.name : "unknown", code: allowedCodes.has(candidate.code) ? candidate.code : "unknown", frames } }));
}
`;
await writeFile(path, source.replace(marker, instrumentation + marker), "utf8");
console.log(JSON.stringify({ ownedStartupArtifactInstrumented: true, diagnosticOnly: true }));
