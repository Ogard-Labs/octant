import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  WORK_CONFINEMENT_BROKER_BUNDLE_ID,
  WORK_CONFINEMENT_GATE_BUNDLE_ID,
  buildWorkConfinementGate,
} from "./build-work-confinement-gate";

const repositoryRoot = resolve(import.meta.dirname, "..");
const nativeSourceDirectory = resolve(repositoryRoot, "apps/desktop/native/work-confinement-gate");

export const ALLOWED_GATE_ENTITLEMENTS = [
  "com.apple.security.app-sandbox",
  "com.apple.security.files.user-selected.read-write",
] as const;
export const ALLOWED_BROKER_ENTITLEMENTS = [
  "com.apple.security.app-sandbox",
  "com.apple.security.files.user-selected.read-write",
  "com.apple.security.files.bookmarks.app-scope",
] as const;
export const WORK_CONFINEMENT_SIGNING_ORDER = [
  "foreignBundle",
  "brokerBundle",
  "appBundle",
] as const;

export function workConfinementSigningOrder(appBundle: string): readonly string[] {
  return [
    resolve(appBundle, "Contents/XPCServices/OctantWorkConfinementForeignClient.xpc"),
    resolve(appBundle, "Contents/XPCServices/OctantWorkConfinementBroker.xpc"),
    appBundle,
  ];
}

export const workConfinementArchitectureArgs = (executable: string) => [
  "lipo",
  executable,
  "-verify_arch",
  "arm64",
];

export function exactPeerRequirement(identifier: string, cdhash: string): string {
  if (!/^[0-9a-f]{6,128}$/i.test(cdhash)) throw new Error("invalid cdhash");
  return `identifier "${identifier}" and cdhash H"${cdhash.toLowerCase()}"`;
}

export function foreignClientInfoPlist(): Plist {
  return {
    CFBundleExecutable: "OctantWorkConfinementForeignClient",
    CFBundleIdentifier: "app.octant.desktop.work-confinement-gate.foreign-client",
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: "Octant Work Confinement Foreign Client",
    CFBundlePackageType: "XPC!",
    CFBundleShortVersionString: "0.0.0",
    CFBundleVersion: "1",
    LSMinimumSystemVersion: "14.0",
    XPCService: { ServiceType: "Application" },
  };
}

type Plist = Readonly<Record<string, unknown>>;

export function workConfinementBundlePaths(outputRoot: string) {
  const appBundle = resolve(outputRoot, "Octant Work Confinement Gate.app");
  const brokerBundle = resolve(appBundle, "Contents/XPCServices/OctantWorkConfinementBroker.xpc");
  const foreignBundle = resolve(
    appBundle,
    "Contents/XPCServices/OctantWorkConfinementForeignClient.xpc",
  );
  return {
    appBundle,
    appExecutable: resolve(appBundle, "Contents/MacOS/OctantWorkConfinementGate"),
    brokerBundle,
    brokerExecutable: resolve(brokerBundle, "Contents/MacOS/OctantWorkConfinementBroker"),
    foreignBundle,
    foreignClient: resolve(foreignBundle, "Contents/MacOS/OctantWorkConfinementForeignClient"),
  } as const;
}

export function validateWorkConfinementEntitlements(
  entitlements: Plist,
  allowed: readonly string[],
): void {
  for (const [key, value] of Object.entries(entitlements)) {
    if (!allowed.includes(key)) throw new Error(`forbidden entitlement ${key}`);
    if (value !== true) throw new Error(`entitlement ${key} must be true`);
  }
  for (const key of allowed) {
    if (entitlements[key] !== true) throw new Error(`missing entitlement ${key}`);
  }
}

function matches(plist: Plist, expected: Plist): boolean {
  return Object.entries(expected).every(([key, value]) => plist[key] === value);
}

export function validateWorkConfinementInfoPlists(host: Plist, broker: Plist): void {
  if (
    !matches(host, {
      CFBundleExecutable: "OctantWorkConfinementGate",
      CFBundleIdentifier: WORK_CONFINEMENT_GATE_BUNDLE_ID,
      CFBundlePackageType: "APPL",
      LSMinimumSystemVersion: "14.0",
      LSUIElement: true,
    })
  ) {
    throw new Error("invalid host Info.plist");
  }
  if (
    !matches(broker, {
      CFBundleExecutable: "OctantWorkConfinementBroker",
      CFBundleIdentifier: WORK_CONFINEMENT_BROKER_BUNDLE_ID,
      CFBundlePackageType: "XPC!",
      LSMinimumSystemVersion: "14.0",
    }) ||
    JSON.stringify(broker.XPCService) !== JSON.stringify({ ServiceType: "Application" })
  ) {
    throw new Error("invalid broker Info.plist");
  }
}

async function run(command: readonly string[]): Promise<void> {
  const process = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await process.exited) !== 0) throw new Error(`Command failed: ${command[0]}`);
}

async function readPlist(path: string): Promise<Plist> {
  const process = Bun.spawn(["plutil", "-convert", "json", "-o", "-", path], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) throw new Error(`Could not read plist ${path}`);
  return JSON.parse(output) as Plist;
}

async function readSignedEntitlements(executable: string, scratchPath: string): Promise<Plist> {
  const process = Bun.spawn(["codesign", "-d", "--entitlements", ":-", executable], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Could not inspect entitlements for ${executable}`);
  if (output.trim().length === 0) return {};
  await writeFile(scratchPath, output, { mode: 0o600 });
  try {
    return await readPlist(scratchPath);
  } finally {
    await rm(scratchPath, { force: true });
  }
}

export async function entitlementKeys(path: string): Promise<readonly string[]> {
  const source = await readFile(path, "utf8");
  return [...source.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1] ?? "");
}

function optionValue(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

export async function packageWorkConfinementGate(
  outputRoot = optionValue("--output") ?? resolve(repositoryRoot, "out/work-confinement-gate"),
): Promise<string> {
  const resolvedOutputRoot = resolve(repositoryRoot, outputRoot);
  const buildRoot = resolve(resolvedOutputRoot, "build");
  const packageRoot = resolve(resolvedOutputRoot, "package");
  const paths = workConfinementBundlePaths(packageRoot);
  await rm(packageRoot, { recursive: true, force: true });
  await buildWorkConfinementGate(repositoryRoot, buildRoot);

  await Promise.all([
    mkdir(resolve(paths.appBundle, "Contents/MacOS"), { recursive: true }),
    mkdir(resolve(paths.brokerBundle, "Contents/MacOS"), { recursive: true }),
    mkdir(resolve(paths.foreignBundle, "Contents/MacOS"), { recursive: true }),
  ]);
  await writeFile(
    resolve(paths.foreignBundle, "Contents/Info.plist"),
    JSON.stringify(foreignClientInfoPlist()),
    { mode: 0o600 },
  );
  await run(["plutil", "-convert", "xml1", resolve(paths.foreignBundle, "Contents/Info.plist")]);
  await Promise.all([
    copyFile(
      resolve(nativeSourceDirectory, "OctantWorkConfinementGate-Info.plist"),
      resolve(paths.appBundle, "Contents/Info.plist"),
    ),
    copyFile(
      resolve(nativeSourceDirectory, "OctantWorkConfinementBroker-Info.plist"),
      resolve(paths.brokerBundle, "Contents/Info.plist"),
    ),
    copyFile(resolve(buildRoot, "OctantWorkConfinementGate"), paths.appExecutable),
    copyFile(resolve(buildRoot, "OctantWorkConfinementBroker"), paths.brokerExecutable),
    copyFile(resolve(buildRoot, "OctantWorkConfinementForeignClient"), paths.foreignClient),
  ]);
  await Promise.all([
    chmod(paths.appExecutable, 0o755),
    chmod(paths.brokerExecutable, 0o755),
    chmod(paths.foreignClient, 0o755),
  ]);

  const [hostInfo, brokerInfo, hostEntitlements, brokerEntitlements] = await Promise.all([
    readPlist(resolve(paths.appBundle, "Contents/Info.plist")),
    readPlist(resolve(paths.brokerBundle, "Contents/Info.plist")),
    readPlist(resolve(nativeSourceDirectory, "OctantWorkConfinementGate.entitlements")),
    readPlist(resolve(nativeSourceDirectory, "OctantWorkConfinementBroker.entitlements")),
  ]);
  validateWorkConfinementInfoPlists(hostInfo, brokerInfo);
  validateWorkConfinementEntitlements(hostEntitlements, ALLOWED_GATE_ENTITLEMENTS);
  validateWorkConfinementEntitlements(brokerEntitlements, ALLOWED_BROKER_ENTITLEMENTS);

  await run([
    "codesign",
    "--force",
    "--sign",
    "-",
    "--identifier",
    WORK_CONFINEMENT_GATE_BUNDLE_ID,
    paths.foreignBundle,
  ]);
  await run([
    "codesign",
    "--force",
    "--sign",
    "-",
    "--entitlements",
    resolve(nativeSourceDirectory, "OctantWorkConfinementBroker.entitlements"),
    paths.brokerBundle,
  ]);
  await run([
    "codesign",
    "--force",
    "--sign",
    "-",
    "--entitlements",
    resolve(nativeSourceDirectory, "OctantWorkConfinementGate.entitlements"),
    paths.appBundle,
  ]);
  const [signedHostEntitlements, signedBrokerEntitlements, signedForeignEntitlements] =
    await Promise.all([
      readSignedEntitlements(paths.appExecutable, resolve(resolvedOutputRoot, "host.entitlements")),
      readSignedEntitlements(
        paths.brokerExecutable,
        resolve(resolvedOutputRoot, "broker.entitlements"),
      ),
      readSignedEntitlements(
        paths.foreignClient,
        resolve(resolvedOutputRoot, "foreign.entitlements"),
      ),
    ]);
  validateWorkConfinementEntitlements(signedHostEntitlements, ALLOWED_GATE_ENTITLEMENTS);
  validateWorkConfinementEntitlements(signedBrokerEntitlements, ALLOWED_BROKER_ENTITLEMENTS);
  validateWorkConfinementEntitlements(signedForeignEntitlements, []);
  await run(["codesign", "--verify", "--deep", "--strict", paths.appBundle]);
  for (const executable of [paths.appExecutable, paths.brokerExecutable, paths.foreignClient]) {
    await run(workConfinementArchitectureArgs(executable));
  }

  return paths.appBundle;
}

if (import.meta.main) {
  const bundle = await packageWorkConfinementGate();
  process.stdout.write(`${bundle}\n`);
}
