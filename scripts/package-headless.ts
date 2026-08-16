import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  encodeHeadlessArtifactManifest,
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  inspectHeadlessArtifact,
  type HeadlessArtifactComponentRole,
  type HeadlessArtifactManifest,
  type HeadlessArtifactTarget,
} from "@octant/host-runtime";
import { MIGRATIONS, type Migration } from "../apps/server/src/persistence/migrations";

// Reproducible headless artifact build. The same component inputs always
// produce byte-identical trees and tarballs: components are ordered by path,
// tar entries carry fixed ownership and zero timestamps, and the manifest is
// the canonical JSON encoding from @octant/host-runtime.

export const HEADLESS_ARTIFACT_TARGETS: ReadonlyArray<HeadlessArtifactTarget> = [
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
];

const REQUIRED_ROLES: ReadonlyArray<HeadlessArtifactComponentRole> = [
  "server",
  "cli",
  "web-assets",
  "native-module",
  "migrations",
  "notices",
  "service-template",
];

const VERSIONED_ROLES = new Set<HeadlessArtifactComponentRole>(["server", "cli", "web-assets"]);
const EXECUTABLE_ROLES = new Set<HeadlessArtifactComponentRole>(["cli", "native-module"]);

export interface HeadlessComponentSource {
  readonly role: HeadlessArtifactComponentRole;
  /** Confined relative path inside the artifact. */
  readonly path: string;
  /** Absolute path of the source file on the build host. */
  readonly source: string;
}

export interface BuildHeadlessArtifactOptions {
  readonly version: string;
  readonly target: HeadlessArtifactTarget;
  readonly wireVersion: string;
  readonly storeVersion: number;
  readonly components: ReadonlyArray<HeadlessComponentSource>;
  readonly outputDirectory: string;
}

export interface BuiltHeadlessArtifact {
  readonly artifactRoot: string;
  readonly tarPath: string;
  readonly manifest: HeadlessArtifactManifest;
}

export async function buildHeadlessArtifact(
  options: BuildHeadlessArtifactOptions,
): Promise<BuiltHeadlessArtifact> {
  for (const role of REQUIRED_ROLES) {
    if (!options.components.some((component) => component.role === role)) {
      throw new Error(`Headless artifact build is missing a required ${role} component.`);
    }
  }

  const artifactName = `octant-${options.version}-${options.target.platform}-${options.target.arch}`;
  const artifactRoot = join(options.outputDirectory, artifactName);
  await rm(artifactRoot, { force: true, recursive: true });
  await mkdir(artifactRoot, { recursive: true });

  const ordered = [...options.components].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const manifestComponents = [];
  for (const component of ordered) {
    const contents = await readFile(component.source);
    const destination = join(artifactRoot, component.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
    await chmod(destination, EXECUTABLE_ROLES.has(component.role) ? 0o755 : 0o644);
    manifestComponents.push({
      role: component.role,
      path: component.path,
      sha256: createHash("sha256").update(contents).digest("hex"),
      byteLength: contents.byteLength,
      ...(VERSIONED_ROLES.has(component.role) ? { version: options.version } : {}),
    });
  }

  const manifest: HeadlessArtifactManifest = {
    schemaVersion: 1,
    product: "octant",
    artifactVersion: options.version,
    target: options.target,
    wireVersion: options.wireVersion,
    storeVersion: options.storeVersion,
    components: manifestComponents,
  };
  await writeFile(
    join(artifactRoot, HEADLESS_ARTIFACT_MANIFEST_FILENAME),
    encodeHeadlessArtifactManifest(manifest),
  );
  await chmod(join(artifactRoot, HEADLESS_ARTIFACT_MANIFEST_FILENAME), 0o644);

  // Static self-inspection: the build fails closed rather than shipping an
  // artifact that its own runtime would refuse. Native-module loading is
  // skipped because artifacts are routinely built for foreign targets.
  const inspection = await inspectHeadlessArtifact({
    artifactRoot,
    runtime: {
      platform: options.target.platform,
      arch: options.target.arch,
      wireVersion: options.wireVersion,
      storeVersion: options.storeVersion,
    },
  });
  if (!inspection.ok) {
    throw new Error(`Built headless artifact failed inspection: ${inspection.rejection.code}.`);
  }

  const tarPath = join(options.outputDirectory, `${artifactName}.tar.gz`);
  await writeFile(tarPath, await createDeterministicTarball(artifactRoot, artifactName));
  return { artifactRoot, tarPath, manifest };
}

/**
 * Builds a gzip-compressed POSIX ustar archive with fully deterministic
 * metadata: entries sorted by path, uid/gid 0, mtime 0, and role-derived
 * permissions. Byte-identical inputs produce byte-identical tarballs.
 */
async function createDeterministicTarball(
  artifactRoot: string,
  archivePrefix: string,
): Promise<Buffer> {
  const files = await collectFiles(artifactRoot);
  files.sort((left, right) => left.localeCompare(right));
  const blocks: Buffer[] = [];
  for (const relativePath of files) {
    const absolutePath = join(artifactRoot, relativePath);
    const contents = await readFile(absolutePath);
    const metadata = await stat(absolutePath);
    const mode = (metadata.mode & 0o111) === 0 ? 0o644 : 0o755;
    blocks.push(tarHeader(`${archivePrefix}/${relativePath}`, contents.byteLength, mode));
    blocks.push(contents);
    const remainder = contents.byteLength % 512;
    if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder));
  }
  blocks.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function tarHeader(name: string, size: number, mode: number): Buffer {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`Headless artifact path is too long for a ustar header: ${name}`);
  }
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0); // mtime
  header.fill(" ", 148, 156); // checksum placeholder
  header.write("0", 156, 1, "utf8"); // regular file
  header.write("ustar", 257, 5, "utf8");
  header.write("00", 263, 2, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  return header;
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "utf8");
}

async function collectFiles(root: string, directory = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await collectFiles(root, absolutePath)));
    } else if (entry.isFile()) {
      output.push(relative(root, absolutePath).split(sep).join("/"));
    }
  }
  return output;
}

/**
 * Service descriptor templates shipped inside the artifact. `{{OCTANT_*}}`
 * placeholders are substituted at install time; the live service manager in
 * @octant/cli remains the authority for enabled installations.
 */
export function renderHeadlessServiceTemplate(platform: "darwin" | "linux"): string {
  if (platform === "linux") {
    return [
      "[Unit]",
      "Description=Octant per-user host service",
      "After=default.target",
      "StartLimitIntervalSec=60s",
      "StartLimitBurst=5",
      "",
      "[Service]",
      "ExecStart={{OCTANT_INSTALL_ROOT}}/current/bin/octant server run",
      "Environment=OCTANT_DATA_DIR={{OCTANT_DATA_DIR}}",
      "Environment=OCTANT_ARTIFACT_ROOT={{OCTANT_INSTALL_ROOT}}/current",
      "Restart=on-failure",
      "RestartSec=1s",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    "<key>Label</key><string>app.octant.host</string>",
    "<key>ProgramArguments</key><array>",
    "<string>{{OCTANT_INSTALL_ROOT}}/current/bin/octant</string>",
    "<string>server</string>",
    "<string>run</string>",
    "</array>",
    "<key>EnvironmentVariables</key><dict>",
    "<key>OCTANT_DATA_DIR</key><string>{{OCTANT_DATA_DIR}}</string>",
    "<key>OCTANT_ARTIFACT_ROOT</key><string>{{OCTANT_INSTALL_ROOT}}/current</string>",
    "</dict>",
    "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "<key>ThrottleInterval</key><integer>30</integer>",
    "<key>RunAtLoad</key><true/>",
    "</dict></plist>",
    "",
  ].join("\n");
}

/** Store migration metadata shipped as `share/migrations.json`. */
export function headlessMigrationsMetadata(
  migrations: ReadonlyArray<Pick<Migration, "version" | "name" | "sql">>,
): string {
  const storeVersion = migrations.at(-1)?.version ?? 0;
  return `${JSON.stringify(
    {
      storeVersion,
      migrations: migrations.map((migration) => ({
        version: migration.version,
        name: migration.name,
        checksum: createHash("sha256").update(migration.sql).digest("hex"),
      })),
    },
    null,
    2,
  )}\n`;
}

// Real-build assembly: gathers built outputs from the repository and produces
// the artifact for the requested target (default: the build host itself).
// Cross-target native modules must be provided via OCTANT_NATIVE_MODULE_DIR
// because this host can only produce its own platform's binaries.

async function assembleRepositoryArtifact(
  repositoryRoot: string,
  target: HeadlessArtifactTarget,
): Promise<BuiltHeadlessArtifact> {
  const version = process.env.OCTANT_ARTIFACT_VERSION ?? "0.0.0-dev";
  const outputDirectory = resolve(repositoryRoot, "out", "headless");
  const scratch = join(outputDirectory, ".generated");
  await mkdir(scratch, { recursive: true });

  const components: HeadlessComponentSource[] = [];
  const push = (role: HeadlessArtifactComponentRole, path: string, source: string) =>
    components.push({ role, path, source });

  await requireBuiltFile(repositoryRoot, "apps/server/dist/main.mjs");
  const serverDist = resolve(repositoryRoot, "apps/server/dist");
  for (const file of await collectFiles(serverDist)) {
    push("server", `lib/server/${file}`, join(serverDist, file));
  }
  await requireBuiltFile(repositoryRoot, "packages/cli/dist/bin.mjs");
  push("cli", "bin/octant", resolve(repositoryRoot, "packages/cli/dist/bin.mjs"));

  const webDist = resolve(repositoryRoot, "apps/web/dist");
  for (const file of await collectFiles(webDist)) {
    push("web-assets", `share/web/${file}`, join(webDist, file));
  }

  const nativeDirectory =
    process.env.OCTANT_NATIVE_MODULE_DIR ??
    join(
      dirname(
        createRequire(resolve(repositoryRoot, "apps/server/package.json")).resolve(
          "better-sqlite3/package.json",
        ),
      ),
      "build/Release",
    );
  push(
    "native-module",
    "lib/native/better_sqlite3.node",
    join(nativeDirectory, "better_sqlite3.node"),
  );

  const migrationsPath = join(scratch, "migrations.json");
  await writeFile(migrationsPath, headlessMigrationsMetadata(MIGRATIONS));
  push("migrations", "share/migrations.json", migrationsPath);

  const noticesPath = join(scratch, "NOTICES.txt");
  await cp(resolve(repositoryRoot, "LICENSE"), noticesPath);
  push("notices", "share/NOTICES.txt", noticesPath);

  const templatePath = join(scratch, `service.${target.platform}.template`);
  await writeFile(templatePath, renderHeadlessServiceTemplate(target.platform));
  push(
    "service-template",
    target.platform === "linux"
      ? "share/service/octant.service.template"
      : "share/service/app.octant.host.plist.template",
    templatePath,
  );

  return buildHeadlessArtifact({
    version,
    target,
    wireVersion: "1",
    storeVersion: MIGRATIONS.at(-1)?.version ?? 0,
    components,
    outputDirectory,
  });
}

async function requireBuiltFile(repositoryRoot: string, repositoryPath: string): Promise<void> {
  const metadata = await stat(resolve(repositoryRoot, repositoryPath)).catch(() => undefined);
  if (!metadata?.isFile()) {
    throw new Error(
      `Required built output is missing: ${repositoryPath}. Run bun run build first.`,
    );
  }
}

if (import.meta.main) {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const requested = process.argv[2];
  const target =
    HEADLESS_ARTIFACT_TARGETS.find(
      (candidate) => `${candidate.platform}-${candidate.arch}` === requested,
    ) ??
    HEADLESS_ARTIFACT_TARGETS.find(
      (candidate) =>
        candidate.platform === process.platform &&
        candidate.arch === (process.arch === "arm64" ? "arm64" : "x64"),
    );
  if (target === undefined) {
    throw new Error(
      `Unknown headless target ${requested}. Supported: ${HEADLESS_ARTIFACT_TARGETS.map(
        (candidate) => `${candidate.platform}-${candidate.arch}`,
      ).join(", ")}.`,
    );
  }
  const built = await assembleRepositoryArtifact(repositoryRoot, target);
  console.log(`Built headless artifact: ${built.tarPath}`);
}
