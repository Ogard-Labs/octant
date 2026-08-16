import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { InspectedExtensionPackage } from "./packageInspector";
import { calculateExtensionPackageDigest, type ExtensionArchiveEntry } from "./packageInspector";

const APPROVED_HOST_EXECUTABLE_DIRECTORIES = new Set([
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
]);

export interface ExtensionVersionReference {
  readonly extensionId: string;
  readonly packageId: string;
  readonly version: string;
  readonly digest: string;
}

export interface StagedExtensionPackage {
  readonly transactionId: string;
  readonly target: ExtensionVersionReference;
}

export interface ExtensionStoreInventoryItem {
  readonly kind: "staging" | "version" | "quarantine";
  readonly opaqueId: string;
  readonly readable: boolean;
  readonly target?: ExtensionVersionReference;
}

export interface ExtensionStorePermissionAudit {
  readonly rootMode: number;
  readonly stagingMode: number;
  readonly versionsMode: number;
  readonly quarantineMode: number;
  readonly metadataMode: number;
  readonly versionMode?: number;
  readonly fileModes: ReadonlyArray<number>;
}

export class ExtensionPackageStoreError extends Error {
  override readonly name = "ExtensionPackageStoreError";

  constructor(
    readonly category: "invalid" | "conflict" | "unavailable" | "corrupt",
    message: string,
  ) {
    super(message);
  }
}

export class ExtensionPackageStore {
  readonly #uuid: () => string;
  readonly #root: string;
  readonly #staging: string;
  readonly #versions: string;
  readonly #quarantine: string;
  readonly #metadata: string;
  readonly #pluginData: string;

  constructor(options: { readonly dataDirectory: string; readonly uuid: () => string }) {
    this.#uuid = options.uuid;
    this.#root = join(options.dataDirectory, "extensions");
    this.#staging = join(this.#root, "staging");
    this.#versions = join(this.#root, "versions");
    this.#quarantine = join(this.#root, "quarantine");
    this.#metadata = join(this.#root, "metadata");
    this.#pluginData = join(this.#root, "plugin-data");
  }

  async initialize(): Promise<void> {
    for (const directory of [
      this.#root,
      this.#staging,
      this.#versions,
      this.#quarantine,
      this.#metadata,
      this.#pluginData,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
  }

  async stage(inspection: InspectedExtensionPackage): Promise<StagedExtensionPackage> {
    const transactionId = validateUuid(this.#uuid());
    const target = targetForManifest(inspection.manifest);
    const directory = join(this.#staging, transactionId);
    const contentDirectory = join(directory, "content");
    try {
      await mkdir(contentDirectory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await chmod(contentDirectory, 0o700);
      for (const file of inspection.files) {
        const destination = safeContentPath(contentDirectory, file.path);
        const parent = destination.slice(0, destination.lastIndexOf("/"));
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await chmod(parent, 0o700);
        await writeFile(destination, file.content, {
          flag: "wx",
          mode: file.executable ? 0o700 : 0o600,
        });
      }
      const receipt: StoredPackageReceipt = {
        schemaVersion: 1,
        transactionId,
        target,
        manifest: inspection.manifest,
        entryPoints: inspection.entryPoints,
        configurationReferences: inspection.configurationReferences,
        contentReferences: inspection.contentReferences,
        files: inspection.files.map((file) => ({
          path: file.path,
          executable: file.executable,
          bytes: file.content.byteLength,
        })),
      };
      await writeFile(join(directory, "receipt.json"), JSON.stringify(receipt), {
        flag: "wx",
        mode: 0o600,
      });
      return { transactionId, target };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof ExtensionPackageStoreError) throw error;
      throw new ExtensionPackageStoreError("unavailable", "Extension package staging failed.");
    }
  }

  async promote(staged: StagedExtensionPackage): Promise<ExtensionVersionReference> {
    const transactionId = validateUuid(staged.transactionId);
    validateTarget(staged.target);
    const source = join(this.#staging, transactionId);
    const receipt = await readReceipt(source);
    if (!sameTarget(receipt.target, staged.target) || receipt.transactionId !== transactionId) {
      throw new ExtensionPackageStoreError("corrupt", "Extension staging receipt is invalid.");
    }
    const destination = this.#versionPath(staged.target);
    await mkdir(destination.slice(0, destination.lastIndexOf("/")), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await rename(source, destination);
    } catch {
      if (await exists(destination)) {
        throw new ExtensionPackageStoreError(
          "conflict",
          "Immutable extension version already exists.",
        );
      }
      throw new ExtensionPackageStoreError("unavailable", "Extension version promotion failed.");
    }
    await hardenImmutable(destination);
    await writeFile(
      join(this.#metadata, `${transactionId}.json`),
      JSON.stringify({ schemaVersion: 1, transactionId, target: staged.target, state: "promoted" }),
      { flag: "wx", mode: 0o600 },
    );
    await chmod(join(this.#metadata, `${transactionId}.json`), 0o400);
    return staged.target;
  }

  async verifyVersion(target: ExtensionVersionReference): Promise<boolean> {
    try {
      validateTarget(target);
      const directory = this.#versionPath(target);
      const receipt = await readReceipt(directory);
      if (!sameTarget(receipt.target, target)) return false;
      const expectedPaths = new Set(receipt.files.map((file) => file.path));
      const observedPaths = await listRelativeFiles(join(directory, "content"));
      if (
        observedPaths.length !== expectedPaths.size ||
        observedPaths.some((path) => !expectedPaths.has(path))
      ) {
        return false;
      }
      const entries: Array<ExtensionArchiveEntry> = [];
      for (const file of receipt.files) {
        const path = safeContentPath(join(directory, "content"), file.path);
        const metadata = await stat(path);
        if (!metadata.isFile() || metadata.size !== file.bytes) return false;
        entries.push({
          path: file.path,
          kind: "file",
          content: await readFile(path),
          executable: file.executable,
        });
      }
      const manifest = restoreRawEntryPoints(receipt);
      return calculateExtensionPackageDigest(manifest, entries) === target.digest;
    } catch {
      return false;
    }
  }

  async readVerifiedComponentText(
    target: ExtensionVersionReference,
    componentId: string,
  ): Promise<string> {
    validateTarget(target);
    if (!(await this.verifyVersion(target))) {
      throw new ExtensionPackageStoreError("corrupt", "Extension package verification failed.");
    }
    const directory = this.#versionPath(target);
    const receipt = await readReceipt(directory);
    const component = receipt.manifest.components.find((candidate) => candidate.id === componentId);
    if (component?.kind !== "skill-instructions") {
      throw new ExtensionPackageStoreError("invalid", "Extension component material is invalid.");
    }
    const reference = receipt.contentReferences?.[componentId];
    if (reference === undefined) {
      throw new ExtensionPackageStoreError("corrupt", "Extension component material is missing.");
    }
    const path = safeContentPath(join(directory, "content"), reference);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
    } catch (error) {
      if (error instanceof ExtensionPackageStoreError) throw error;
      throw new ExtensionPackageStoreError("corrupt", "Extension component material is invalid.");
    }
  }

  contentRoot(target: ExtensionVersionReference): string {
    validateTarget(target);
    return join(this.#versionPath(target), "content");
  }

  pluginDataRoot(): string {
    return this.#pluginData;
  }

  async readVerifiedConfiguration(
    target: ExtensionVersionReference,
    componentId: string,
  ): Promise<string> {
    validateTarget(target);
    if (!(await this.verifyVersion(target))) {
      throw new ExtensionPackageStoreError("corrupt", "Extension package verification failed.");
    }
    const directory = this.#versionPath(target);
    const receipt = await readReceipt(directory);
    const component = receipt.manifest.components.find((candidate) => candidate.id === componentId);
    if (component?.kind !== "mcp-server") {
      throw new ExtensionPackageStoreError(
        "invalid",
        "Extension MCP configuration component is invalid.",
      );
    }
    const reference = receipt.configurationReferences?.[componentId];
    if (reference === undefined) {
      throw new ExtensionPackageStoreError("corrupt", "Extension MCP configuration is missing.");
    }
    const path = safeContentPath(join(directory, "content"), reference);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
    } catch (error) {
      if (error instanceof ExtensionPackageStoreError) throw error;
      throw new ExtensionPackageStoreError("corrupt", "Extension MCP configuration is invalid.");
    }
  }

  async authorizeRuntimeLaunch(input: {
    readonly extensionId: string;
    readonly packageId: string;
    readonly componentId: string;
    readonly version: string;
    readonly digest: string;
    readonly entryPoint: string;
    readonly command: string;
    readonly cwd: string;
  }): Promise<boolean> {
    const target: ExtensionVersionReference = {
      extensionId: input.extensionId,
      packageId: input.packageId,
      version: input.version,
      digest: input.digest,
    };
    try {
      const directory = this.#versionPath(target);
      const receipt = await readReceipt(directory);
      const relativeEntryPoint = receipt.entryPoints[input.componentId];
      if (!(await this.verifyVersion(target))) return false;
      const contentRoot = join(directory, "content");
      const pluginDataRoot = join(
        this.pluginDataRoot(),
        `${target.extensionId}-${target.packageId}`,
      );
      const cwdAllowed =
        isContainedPath(contentRoot, input.cwd) || isContainedPath(pluginDataRoot, input.cwd);
      if (relativeEntryPoint !== undefined) {
        const entry = receipt.files.find((file) => file.path === relativeEntryPoint);
        if (entry?.executable !== true) return false;
        const expectedEntryPoint = safeContentPath(contentRoot, relativeEntryPoint);
        return (
          input.entryPoint === expectedEntryPoint &&
          input.command === expectedEntryPoint &&
          cwdAllowed
        );
      }
      const configurationReference = receipt.configurationReferences?.[input.componentId];
      if (configurationReference === undefined) return false;
      if (
        input.entryPoint === safeContentPath(contentRoot, configurationReference) &&
        isAbsolute(input.command) &&
        APPROVED_HOST_EXECUTABLE_DIRECTORIES.has(dirname(input.command))
      ) {
        return cwdAllowed;
      }
      const commandRelativePath = relative(contentRoot, input.command);
      if (
        commandRelativePath.length === 0 ||
        isAbsolute(commandRelativePath) ||
        commandRelativePath.split(/[\\/]/).some((segment) => segment === "..")
      ) {
        return false;
      }
      const commandEntry = receipt.files.find(
        (file) => file.path === commandRelativePath.replaceAll("\\", "/"),
      );
      return (
        commandEntry?.executable === true &&
        input.entryPoint === safeContentPath(contentRoot, configurationReference) &&
        cwdAllowed
      );
    } catch {
      return false;
    }
  }

  async quarantineStage(transactionId: string, reason: string): Promise<void> {
    validateReason(reason);
    const entry = validateStoreEntryName(transactionId);
    const opaqueId = /^[a-f0-9-]{36}$/i.test(entry)
      ? `stage-${entry.toLowerCase()}`
      : `stage-orphan-${createHash("sha256").update(entry).digest("hex").slice(0, 32)}`;
    await this.#moveToQuarantine(join(this.#staging, entry), opaqueId, reason);
  }

  async quarantineVersion(target: ExtensionVersionReference, reason: string): Promise<void> {
    validateTarget(target);
    validateReason(reason);
    await this.#moveToQuarantine(
      this.#versionPath(target),
      `version-${validateUuid(this.#uuid())}`,
      reason,
    );
  }

  async quarantineInventoryItem(item: ExtensionStoreInventoryItem, reason: string): Promise<void> {
    validateReason(reason);
    if (item.kind === "staging") {
      await this.quarantineStage(item.opaqueId, reason);
      return;
    }
    if (item.kind !== "version") return;
    for (const extension of await directoryNames(this.#versions)) {
      for (const packageId of await directoryNames(join(this.#versions, extension))) {
        for (const version of await directoryNames(join(this.#versions, extension, packageId))) {
          if (opaqueVersionId(extension, packageId, version) !== item.opaqueId) continue;
          const opaqueId = `version-orphan-${createHash("sha256")
            .update(item.opaqueId)
            .digest("hex")
            .slice(0, 32)}`;
          await this.#moveToQuarantine(
            join(this.#versions, extension, packageId, version),
            opaqueId,
            reason,
          );
          return;
        }
      }
    }
  }

  async removeVersion(target: ExtensionVersionReference): Promise<void> {
    validateTarget(target);
    const directory = this.#versionPath(target);
    if (!(await exists(directory))) return;
    await makeWritable(directory);
    await rm(directory, { recursive: true, force: false });
  }

  async inventory(): Promise<ReadonlyArray<ExtensionStoreInventoryItem>> {
    const items: Array<ExtensionStoreInventoryItem> = [];
    for (const entry of await directoryNames(this.#staging)) {
      const directory = join(this.#staging, entry);
      const receipt = await tryReadReceipt(directory);
      items.push({
        kind: "staging",
        opaqueId: entry,
        readable: receipt !== undefined,
        ...(receipt === undefined ? {} : { target: receipt.target }),
      });
    }
    for (const extension of await directoryNames(this.#versions)) {
      for (const packageId of await directoryNames(join(this.#versions, extension))) {
        for (const version of await directoryNames(join(this.#versions, extension, packageId))) {
          const directory = join(this.#versions, extension, packageId, version);
          const receipt = await tryReadReceipt(directory);
          items.push({
            kind: "version",
            opaqueId: opaqueVersionId(extension, packageId, version),
            readable: receipt !== undefined,
            ...(receipt === undefined ? {} : { target: receipt.target }),
          });
        }
      }
    }
    for (const entry of await directoryNames(this.#quarantine)) {
      const receipt = await tryReadReceipt(join(this.#quarantine, entry));
      items.push({
        kind: "quarantine",
        opaqueId: entry,
        readable: receipt !== undefined,
        ...(receipt === undefined ? {} : { target: receipt.target }),
      });
    }
    return items.sort((left, right) =>
      `${left.kind}:${left.opaqueId}`.localeCompare(`${right.kind}:${right.opaqueId}`),
    );
  }

  async auditPermissions(
    target?: ExtensionVersionReference,
  ): Promise<ExtensionStorePermissionAudit> {
    const base = {
      rootMode: await mode(this.#root),
      stagingMode: await mode(this.#staging),
      versionsMode: await mode(this.#versions),
      quarantineMode: await mode(this.#quarantine),
      metadataMode: await mode(this.#metadata),
    };
    if (target === undefined) return { ...base, fileModes: [] };
    const directory = this.#versionPath(target);
    const files = [join(directory, "receipt.json")];
    for (const path of await listRelativeFiles(join(directory, "content"))) {
      files.push(safeContentPath(join(directory, "content"), path));
    }
    return {
      ...base,
      versionMode: await mode(directory),
      fileModes: await Promise.all(files.sort().map(mode)),
    };
  }

  #versionPath(target: ExtensionVersionReference): string {
    validateTarget(target);
    return join(
      this.#versions,
      target.extensionId,
      target.packageId,
      `${target.version}--${target.digest.slice("sha256:".length)}`,
    );
  }

  async #moveToQuarantine(source: string, opaqueId: string, reason: string): Promise<void> {
    if (!(await exists(source))) return;
    const destination = join(this.#quarantine, opaqueId);
    if (await exists(destination)) return;
    await makeWritable(source);
    await rename(source, destination);
    await writeFile(
      join(destination, "quarantine.json"),
      JSON.stringify({ schemaVersion: 1, reason }),
      { flag: "wx", mode: 0o600 },
    );
    await hardenImmutable(destination);
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length === 0 ||
    (!isAbsolute(relativePath) && !relativePath.split(/[\\/]/).some((segment) => segment === ".."))
  );
}

interface StoredPackageReceipt {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly target: ExtensionVersionReference;
  readonly manifest: InspectedExtensionPackage["manifest"];
  readonly entryPoints: Readonly<Record<string, string>>;
  readonly configurationReferences?: Readonly<Record<string, string>>;
  readonly contentReferences?: Readonly<Record<string, string>>;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly executable: boolean;
    readonly bytes: number;
  }>;
}

function targetForManifest(
  manifest: InspectedExtensionPackage["manifest"],
): ExtensionVersionReference {
  return {
    extensionId: manifest.extensionId,
    packageId: manifest.packageId,
    version: manifest.version,
    digest: manifest.digest,
  };
}

function validateTarget(target: ExtensionVersionReference): void {
  if (
    !/^[a-f0-9-]{36}$/.test(target.extensionId) ||
    !/^[a-f0-9-]{36}$/.test(target.packageId) ||
    !/^[0-9A-Za-z.+-]{1,64}$/.test(target.version) ||
    !/^sha256:[a-f0-9]{64}$/.test(target.digest)
  ) {
    throw new ExtensionPackageStoreError("invalid", "Extension version reference is invalid.");
  }
}

function validateUuid(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
    throw new ExtensionPackageStoreError("invalid", "Extension transaction identity is invalid.");
  }
  return value.toLowerCase();
}

function validateReason(reason: string): void {
  if (!/^[a-z][a-z0-9-]{0,127}$/.test(reason)) {
    throw new ExtensionPackageStoreError("invalid", "Extension quarantine reason is invalid.");
  }
}

function sameTarget(left: ExtensionVersionReference, right: ExtensionVersionReference): boolean {
  return (
    left.extensionId === right.extensionId &&
    left.packageId === right.packageId &&
    left.version === right.version &&
    left.digest === right.digest
  );
}

function safeContentPath(root: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ExtensionPackageStoreError("invalid", "Extension content reference is invalid.");
  }
  return join(root, ...relativePath.split("/"));
}

async function readReceipt(directory: string): Promise<StoredPackageReceipt> {
  const receipt = await tryReadReceipt(directory);
  if (receipt === undefined) {
    throw new ExtensionPackageStoreError("corrupt", "Extension package receipt is invalid.");
  }
  return receipt;
}

async function tryReadReceipt(directory: string): Promise<StoredPackageReceipt | undefined> {
  try {
    const receiptMetadata = await lstat(join(directory, "receipt.json"));
    if (!receiptMetadata.isFile() || receiptMetadata.isSymbolicLink()) return undefined;
    const value = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const receipt = value as Partial<StoredPackageReceipt>;
    if (
      receipt.schemaVersion !== 1 ||
      typeof receipt.transactionId !== "string" ||
      receipt.target === undefined ||
      receipt.manifest === undefined ||
      typeof receipt.entryPoints !== "object" ||
      (receipt.configurationReferences !== undefined &&
        typeof receipt.configurationReferences !== "object") ||
      (receipt.contentReferences !== undefined && typeof receipt.contentReferences !== "object") ||
      !Array.isArray(receipt.files)
    ) {
      return undefined;
    }
    validateUuid(receipt.transactionId);
    validateTarget(receipt.target);
    if (
      receipt.files.some(
        (file) =>
          typeof file !== "object" ||
          file === null ||
          typeof file.path !== "string" ||
          typeof file.executable !== "boolean" ||
          !Number.isSafeInteger(file.bytes) ||
          file.bytes < 0,
      )
    ) {
      return undefined;
    }
    return receipt as StoredPackageReceipt;
  } catch {
    return undefined;
  }
}

function validateStoreEntryName(value: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    throw new ExtensionPackageStoreError("invalid", "Extension store entry is invalid.");
  }
  return value;
}

function restoreRawEntryPoints(receipt: StoredPackageReceipt): unknown {
  return {
    ...receipt.manifest,
    components: receipt.manifest.components.map((component) => ({
      ...component,
      ...(component.entryPoint === undefined
        ? {}
        : { entryPoint: receipt.entryPoints[component.id] }),
      ...(component.configurationReference === undefined
        ? {}
        : { configurationReference: receipt.configurationReferences?.[component.id] }),
      ...(component.contentReference === undefined
        ? {}
        : { contentReference: receipt.contentReferences?.[component.id] }),
    })),
  };
}

async function hardenImmutable(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ExtensionPackageStoreError("corrupt", "Extension package contains an unsafe link.");
    }
    if (entry.isDirectory()) await hardenImmutable(path);
    else if (entry.isFile()) {
      // Preserve executable bit for package-declared executables so supervised
      // plugin-relative MCP commands remain launchable after promotion.
      const current = (await stat(path)).mode;
      const executable = (current & 0o111) !== 0;
      await chmod(path, executable ? 0o500 : 0o400);
    } else {
      throw new ExtensionPackageStoreError(
        "corrupt",
        "Extension package contains an unsafe entry.",
      );
    }
  }
  await chmod(directory, 0o500);
}

async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await makeWritable(path);
    else if (entry.isFile()) await chmod(path, 0o600);
  }
}

async function listRelativeFiles(root: string, prefix = ""): Promise<Array<string>> {
  const files: Array<string> = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new ExtensionPackageStoreError("corrupt", "Extension package contains an unsafe link.");
    }
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
    else
      throw new ExtensionPackageStoreError(
        "corrupt",
        "Extension package contains an unsafe entry.",
      );
  }
  return files.sort();
}

async function directoryNames(directory: string): Promise<Array<string>> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

function opaqueVersionId(extensionId: string, packageId: string, version: string): string {
  return `${extensionId.slice(0, 8)}:${packageId.slice(0, 8)}:${version.slice(0, 24)}`;
}
