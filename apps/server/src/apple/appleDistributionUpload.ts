import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import {
  AppleBundleIdentifier,
  AppleBundleVersion,
  decodeAppleDeviceResponse,
  decodeAppleUploadBuild,
  decodeAppleUploadEvidence,
  type AppleBuildOutcome,
  type AppleDeviceRequest,
  type AppleDeviceResponse,
  type AppleTeamId,
  type AppleUploadBuild,
  type AppleUploadEvidence,
} from "@octant/contracts";
import { chooseAppleAppStoreSigning, type AppleDevelopmentSigningGap } from "@octant/domain";
import type { AppStoreConnectKeyFiles } from "../providers/credentialBrokerClient";
import type { AppleDeviceExecutionContext } from "./appleDeviceService";
import {
  parsePropertyList,
  parseSigningIdentities,
  readProvisioningProfiles,
  serializePropertyList,
  type PropertyListDictionary,
  type PropertyListValue,
} from "./appleSigning";
import {
  confinedProjectPath,
  projectSelector,
  type AppleProcessResult,
} from "./appleToolchainService";

/** One confined launch, as the Apple process ports run it. */
export type AppleUploadLaunch = (
  input: {
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly additionalWriteRoots?: ReadonlyArray<string>;
    readonly additionalReadRoots?: ReadonlyArray<string>;
    readonly isolatedRoots?: ReadonlyArray<string>;
  },
  signal?: AbortSignal,
) => Promise<AppleProcessResult>;

export interface AppleDistributionUploadOptions {
  /** The confined Apple launch with the toolchain's own egress: build settings and the archive. */
  readonly execute: AppleUploadLaunch;
  /**
   * The confined launch with no network: the keychain's identities and
   * `xcodebuild -exportArchive`, which signs the archived app for the App Store
   * with the identity and profile the person confirmed. No project script
   * runs under it.
   */
  readonly executeSigning: AppleUploadLaunch;
  /** The one launch that reaches App Store Connect and reads the key file: `xcrun altool`. */
  readonly executeUpload: AppleUploadLaunch;
  /** The broker's key-file routes; undefined on a host with no broker for the key. */
  readonly keyFiles: AppStoreConnectKeyFiles | undefined;
  /** Host-private folders, one per upload, holding its archive and export. */
  readonly uploadRoot: string;
  /**
   * Host-private folders, one per upload, the broker writes the key file into.
   * Every Apple launch but the upload's own is denied this root.
   */
  readonly keyRoot: string;
  /** Other host-private directories every upload launch is denied. */
  readonly isolatedRoots: ReadonlyArray<string>;
  readonly provisioningProfileDirectories: ReadonlyArray<string>;
  readonly realpath: (path: string) => Promise<string>;
  /** Journals what an upload did; never the key or the archive's bytes. */
  readonly recordEvidence?: (evidence: AppleUploadEvidence, startedAt: string) => void;
  readonly now: () => string;
}

/** What the host read from the project before anyone is asked to confirm an upload. */
export type AppleUploadPreparation =
  | { readonly kind: "prepared"; readonly upload: AppleUploadBuild }
  | { readonly kind: "failed"; readonly message: string };

const READ_TIMEOUT_MS = 2 * 60_000;
const EXPORT_TIMEOUT_MS = 20 * 60_000;
const UPLOAD_TIMEOUT_MS = 60 * 60_000;
const MAX_DIAGNOSTICS = 32;
const MAX_DIAGNOSTIC_LENGTH = 2_048;
const ARCHIVE_NAME = "App.xcarchive";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SIGNING_GAPS: Readonly<Record<AppleDevelopmentSigningGap, string>> = {
  "no-signing-identity":
    "The login keychain has no valid signing identity. Add your Apple account in Xcode's Settings and create an Apple Distribution certificate there.",
  "no-provisioning-profile":
    "No installed App Store provisioning profile for this team covers this app. Download one in Xcode, or from the developer website, so it is in Xcode's profiles folder; Octant does not create profiles.",
  "no-identity-for-profile":
    "The App Store profile for this app admits none of the signing identities in the login keychain. Fix distribution signing for this team in Xcode; Octant does not create certificates or profiles.",
};

type Stage =
  | { readonly kind: "done" }
  | { readonly kind: "stopped"; readonly outcome: AppleBuildOutcome; readonly note: string };

const done: Stage = { kind: "done" };
const stopped = (outcome: AppleBuildOutcome, note: string): Stage => ({
  kind: "stopped",
  outcome,
  note,
});

/**
 * A person-confirmed upload of their own app to App Store Connect (slice 7 of
 * docs/design/apple-devices.md). The build the person confirms is read from
 * the project first; the upload then archives the project unsigned, has
 * `xcodebuild -exportArchive` sign the archived app for the App Store with
 * exactly the identity and profile that were confirmed, and uploads the
 * exported package with `xcrun altool`. The key reaches only that last launch,
 * as a `0600` file the credential broker writes into the upload's private key
 * folder and removes when the launch ends; this service never reads it.
 *
 * Nothing here decides who may upload: the device policy has already required
 * a local person's confirmation of exactly this request before it gets here.
 */
export class AppleDistributionUpload {
  readonly #options: AppleDistributionUploadOptions;

  constructor(options: AppleDistributionUploadOptions) {
    this.#options = options;
  }

  /**
   * The build an upload of this project would send: the app, its version and
   * build number, and the App Store signature the export would apply. It only
   * reads, so it runs before anyone is asked.
   */
  async prepare(
    input: {
      readonly projectPath: string;
      readonly scheme?: string;
      readonly teamId: AppleTeamId;
    },
    context: Pick<AppleDeviceExecutionContext, "checkoutRoot">,
    signal?: AbortSignal,
  ): Promise<AppleUploadPreparation> {
    let projectPath: string;
    try {
      projectPath = await confinedProjectPath(
        context.checkoutRoot,
        input.projectPath,
        this.#options.realpath,
      );
    } catch {
      return { kind: "failed", message: "The project is not inside this thread's checkout." };
    }
    const settings = await this.#options.execute(
      {
        argv: [
          ...archiveSelector(input.projectPath, projectPath, input.scheme),
          "-showBuildSettings",
          "-json",
        ],
        cwd: context.checkoutRoot,
        environment: {},
        timeoutMs: READ_TIMEOUT_MS,
        isolatedRoots: this.#isolatedRoots(),
      },
      signal,
    );
    if (!succeeded(settings)) {
      return { kind: "failed", message: "The project's build settings could not be read." };
    }
    const declared = declaredApp(text(settings.stdout));
    if (declared === undefined) {
      return {
        kind: "failed",
        message:
          "The scheme does not build one iOS app with PRODUCT_BUNDLE_IDENTIFIER, MARKETING_VERSION, and CURRENT_PROJECT_VERSION set, so Octant cannot say exactly what it would upload.",
      };
    }
    const listed = await this.#options.executeSigning(
      {
        argv: ["security", "find-identity", "-v", "-p", "codesigning"],
        cwd: this.#options.uploadRoot,
        environment: {},
        timeoutMs: READ_TIMEOUT_MS,
        isolatedRoots: this.#isolatedRoots(),
      },
      signal,
    );
    // The listing names each identity's owner, so none of it is kept. One that
    // could not be read is a failure, never an empty keychain.
    if (!succeeded(listed)) {
      return {
        kind: "failed",
        message: "The login keychain's signing identities could not be listed.",
      };
    }
    const profiles = await readProvisioningProfiles(this.#options.provisioningProfileDirectories);
    const choice = chooseAppleAppStoreSigning({
      teamId: input.teamId,
      bundleIdentifier: declared.bundleIdentifier,
      identities: parseSigningIdentities(text(listed.stdout)),
      profiles: profiles.map((profile) => profile.facts),
      nowMs: Date.parse(this.#options.now()),
    });
    if (choice.kind === "missing") return { kind: "failed", message: SIGNING_GAPS[choice.gap] };
    if (!UUID.test(choice.profileId)) {
      return { kind: "failed", message: SIGNING_GAPS["no-provisioning-profile"] };
    }
    return {
      kind: "prepared",
      upload: decodeAppleUploadBuild({
        bundleIdentifier: declared.bundleIdentifier,
        version: declared.version,
        buildNumber: declared.buildNumber,
        signing: choice.signing,
        profileId: choice.profileId.toLowerCase(),
      }),
    };
  }

  /**
   * Archives, exports, and uploads exactly the build the request names. The
   * project is read again first; if it would now build anything other than
   * what the person confirmed, nothing runs.
   */
  async upload(
    request: AppleDeviceRequest,
    context: AppleDeviceExecutionContext,
    signal?: AbortSignal,
  ): Promise<AppleDeviceResponse> {
    const confirmed = request.upload;
    const projectPathInCheckout = request.projectPath;
    const teamId = request.teamId;
    if (confirmed === undefined || projectPathInCheckout === undefined || teamId === undefined) {
      return refused("upload-changed");
    }
    const startedAt = this.#options.now();
    const notes: string[] = [];
    const current = await this.prepare(
      {
        projectPath: projectPathInCheckout,
        ...(request.scheme === undefined ? {} : { scheme: request.scheme }),
        teamId,
      },
      context,
      signal,
    );
    if (current.kind === "failed") {
      return this.#record(request, startedAt, stopped("failed", current.message), notes);
    }
    if (!sameBuild(current.upload, confirmed)) return refused("upload-changed");
    if (this.#options.keyFiles === undefined) {
      return this.#record(
        request,
        startedAt,
        stopped(
          "unavailable",
          "This host has no credential broker for the App Store Connect key, so it cannot upload.",
        ),
        notes,
      );
    }
    const folder = join(this.#options.uploadRoot, `upload-${String(request.actionId)}`);
    const keyFolder = join(this.#options.keyRoot, `upload-${String(request.actionId)}`);
    await mkdir(this.#options.uploadRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.#options.keyRoot, { recursive: true, mode: 0o700 });
    try {
      // Created here and only here: a reused action id never archives into
      // another upload's folder.
      await mkdir(folder, { mode: 0o700 });
    } catch {
      return this.#record(
        request,
        startedAt,
        stopped("failed", "This upload's action id was already used; issue a new one."),
        notes,
      );
    }
    const projectPath = await confinedProjectPath(
      context.checkoutRoot,
      projectPathInCheckout,
      this.#options.realpath,
    );
    const archived = await this.#archive(
      request,
      context,
      projectPath,
      projectPathInCheckout,
      folder,
      signal,
    );
    if (archived.kind === "stopped") return this.#record(request, startedAt, archived, notes);
    const exported = await this.#export(confirmed, folder, signal);
    if (exported.kind === "stopped") return this.#record(request, startedAt, exported, notes);
    const uploaded = await this.#send(exported.package, keyFolder, request.timeoutMs, signal);
    notes.push(...uploaded.diagnostics);
    const outcome: Stage =
      uploaded.deliveryId !== undefined
        ? done
        : uploaded.stage.kind === "stopped"
          ? uploaded.stage
          : stopped(
              "failed",
              "App Store Connect's answer named no delivery, so Octant does not count the build as uploaded. Check App Store Connect before uploading again.",
            );
    if (outcome.kind === "done") {
      notes.push(
        `Uploaded ${confirmed.bundleIdentifier} ${confirmed.version} (${confirmed.buildNumber}) for team ${confirmed.signing.teamId}, signed by identity ${confirmed.signing.identity}.`,
      );
    }
    return this.#record(request, startedAt, outcome, notes, uploaded.deliveryId);
  }

  /**
   * Removes any key folder an upload left behind, as a restart would find it
   * after a crash between the broker's write and its removal.
   */
  async sweepKeyFolders(): Promise<void> {
    let names: ReadonlyArray<string>;
    try {
      names = await readdir(this.#options.keyRoot);
    } catch {
      return;
    }
    for (const name of names) {
      await rm(join(this.#options.keyRoot, name), { recursive: true, force: true });
    }
  }

  async #archive(
    request: AppleDeviceRequest,
    context: AppleDeviceExecutionContext,
    projectPath: string,
    projectPathInCheckout: string,
    folder: string,
    signal: AbortSignal | undefined,
  ): Promise<Stage> {
    const archive = await this.#options.execute(
      {
        argv: [
          ...archiveSelector(projectPathInCheckout, projectPath, request.scheme),
          "-derivedDataPath",
          join(folder, "derived"),
          "-archivePath",
          join(folder, ARCHIVE_NAME),
          // The archive is built unsigned: no keychain grant is in reach of the
          // project's Run Script phases, and `-allowProvisioningUpdates` is
          // never passed (decision 3). The export signs it.
          "CODE_SIGNING_ALLOWED=NO",
          "archive",
        ],
        cwd: context.checkoutRoot,
        environment: {},
        timeoutMs: request.timeoutMs,
        additionalWriteRoots: [folder],
        isolatedRoots: this.#isolatedRoots(),
      },
      signal,
    );
    if (!succeeded(archive)) return stopped(outcomeFor(archive), "The archive did not succeed.");
    const archivedApp = await readArchivedApp(join(folder, ARCHIVE_NAME, "Info.plist"));
    if (
      archivedApp === undefined ||
      archivedApp.bundleIdentifier !== String(request.upload?.bundleIdentifier) ||
      archivedApp.version !== String(request.upload?.version) ||
      archivedApp.buildNumber !== String(request.upload?.buildNumber)
    ) {
      return stopped(
        "failed",
        "The archive is not the app, version, and build that were confirmed, so it was not uploaded.",
      );
    }
    return done;
  }

  /** Signs the archived app for the App Store with exactly the confirmed identity and profile. */
  async #export(
    confirmed: AppleUploadBuild,
    folder: string,
    signal: AbortSignal | undefined,
  ): Promise<
    | { readonly kind: "done"; readonly package: string }
    | Extract<Stage, { readonly kind: "stopped" }>
  > {
    const optionsPath = join(folder, "ExportOptions.plist");
    await writeFile(optionsPath, appStoreExportOptions(confirmed), { mode: 0o600, flag: "wx" });
    const exportPath = join(folder, "export");
    const exported = await this.#options.executeSigning(
      {
        argv: [
          "xcodebuild",
          "-exportArchive",
          "-archivePath",
          join(folder, ARCHIVE_NAME),
          "-exportPath",
          exportPath,
          "-exportOptionsPlist",
          optionsPath,
        ],
        cwd: folder,
        environment: {},
        timeoutMs: EXPORT_TIMEOUT_MS,
        additionalReadRoots: [folder],
        additionalWriteRoots: [folder],
        isolatedRoots: this.#isolatedRoots(),
      },
      signal,
    );
    if (!succeeded(exported)) {
      return {
        kind: "stopped",
        outcome: outcomeFor(exported),
        note: "The export did not sign the archive for the App Store.",
      };
    }
    const exportedPackage = await onlyPackage(exportPath);
    if (exportedPackage === undefined) {
      return {
        kind: "stopped",
        outcome: "failed",
        note: "The export did not leave exactly one app package to upload.",
      };
    }
    return { kind: "done", package: exportedPackage };
  }

  /** Has the broker write the key, uploads with it, and has the key removed whatever happened. */
  async #send(
    exportedPackage: string,
    keyFolder: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{
    readonly stage: Stage;
    readonly deliveryId?: string;
    readonly diagnostics: ReadonlyArray<string>;
  }> {
    const keyFiles = this.#options.keyFiles;
    if (keyFiles === undefined) {
      return {
        stage: stopped("unavailable", "No App Store Connect key is reachable."),
        diagnostics: [],
      };
    }
    await mkdir(keyFolder, { mode: 0o700 });
    try {
      const key = await keyFiles.write(keyFolder);
      if (key.kind === "missing") {
        return {
          stage: stopped(
            "failed",
            "No App Store Connect key is saved on this Mac. Add one in Settings › Device tools.",
          ),
          diagnostics: [],
        };
      }
      if (key.kind === "unavailable") {
        return {
          stage: stopped(
            "unavailable",
            "The credential broker did not provide the App Store Connect key.",
          ),
          diagnostics: [],
        };
      }
      const upload = await this.#options.executeUpload(
        {
          argv: [
            "xcrun",
            "altool",
            "--upload-package",
            exportedPackage,
            "--api-key",
            key.keyId,
            "--api-issuer",
            key.issuerId,
            "--p8-file-path",
            key.file,
            "--output-format",
            "json",
          ],
          cwd: keyFolder,
          environment: {},
          timeoutMs: Math.min(Math.max(timeoutMs, 60_000), UPLOAD_TIMEOUT_MS),
          additionalReadRoots: [keyFolder, dirname(exportedPackage)],
          isolatedRoots: this.#options.isolatedRoots,
        },
        signal,
      );
      const answer = altoolAnswer(text(upload.stdout));
      if (!succeeded(upload)) {
        return {
          stage: stopped(outcomeFor(upload), "App Store Connect did not take the upload."),
          diagnostics: answer.errors,
        };
      }
      return {
        stage: done,
        ...(answer.deliveryId === undefined ? {} : { deliveryId: answer.deliveryId }),
        diagnostics: answer.errors,
      };
    } finally {
      await keyFiles.remove(keyFolder);
      await rm(keyFolder, { recursive: true, force: true });
    }
  }

  #isolatedRoots(): ReadonlyArray<string> {
    return [this.#options.keyRoot, ...this.#options.isolatedRoots];
  }

  #record(
    request: AppleDeviceRequest,
    startedAt: string,
    stage: Stage,
    notes: ReadonlyArray<string>,
    deliveryId?: string,
  ): AppleDeviceResponse {
    const upload = request.upload;
    if (upload === undefined) return refused("upload-changed");
    const completedAt = this.#options.now();
    const messages = [...notes, ...(stage.kind === "stopped" ? [stage.note] : [])];
    const evidence = decodeAppleUploadEvidence({
      actionId: request.actionId,
      correlationId: request.correlationId,
      authority: request.authority,
      kind: "upload",
      requestedBy: request.requestedBy,
      outcome: stage.kind === "done" ? "succeeded" : stage.outcome,
      upload,
      ...(stage.kind === "done" && deliveryId !== undefined ? { deliveryId } : {}),
      diagnostics: messages.slice(0, MAX_DIAGNOSTICS).map((message) => ({
        severity: stage.kind === "done" ? "note" : "error",
        message: message.slice(0, MAX_DIAGNOSTIC_LENGTH),
      })),
      artifacts: [],
      cleanup: "complete",
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      completedAt,
    });
    this.#options.recordEvidence?.(evidence, startedAt);
    return decodeAppleDeviceResponse({ kind: "apple-upload-evidence", evidence });
  }
}

/**
 * The export options that sign for the App Store with exactly the confirmed
 * identity and profile, and change nothing in the person's account: manual
 * signing, no build-number management, and an export to disk, never an upload
 * by `xcodebuild` itself.
 */
export function appStoreExportOptions(confirmed: AppleUploadBuild): string {
  return serializePropertyList({
    method: "app-store-connect",
    destination: "export",
    signingStyle: "manual",
    teamID: String(confirmed.signing.teamId),
    signingCertificate: String(confirmed.signing.identity),
    provisioningProfiles: { [String(confirmed.bundleIdentifier)]: String(confirmed.profileId) },
    manageAppVersionAndBuildNumber: false,
    uploadSymbols: true,
  });
}

function archiveSelector(
  projectPathInCheckout: string,
  projectPath: string,
  scheme: string | undefined,
): ReadonlyArray<string> {
  return [
    "xcodebuild",
    projectSelector(projectPathInCheckout),
    projectPath,
    ...(scheme === undefined ? [] : ["-scheme", scheme]),
    "-configuration",
    "Release",
    "-destination",
    "generic/platform=iOS",
  ];
}

function declaredApp(output: string):
  | {
      readonly bundleIdentifier: AppleBundleIdentifier;
      readonly version: string;
      readonly buildNumber: string;
    }
  | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const entry of parsed) {
    const settings = isRecord(entry) ? entry.buildSettings : undefined;
    if (!isRecord(settings)) continue;
    const { WRAPPER_NAME, PRODUCT_BUNDLE_IDENTIFIER, MARKETING_VERSION, CURRENT_PROJECT_VERSION } =
      settings;
    if (typeof WRAPPER_NAME !== "string" || !WRAPPER_NAME.endsWith(".app")) continue;
    if (
      !Schema.is(AppleBundleIdentifier)(PRODUCT_BUNDLE_IDENTIFIER) ||
      !Schema.is(AppleBundleVersion)(MARKETING_VERSION) ||
      !Schema.is(AppleBundleVersion)(CURRENT_PROJECT_VERSION)
    ) {
      return undefined;
    }
    return {
      bundleIdentifier: PRODUCT_BUNDLE_IDENTIFIER,
      version: MARKETING_VERSION,
      buildNumber: CURRENT_PROJECT_VERSION,
    };
  }
  return undefined;
}

/** The app an archive holds, from the archive's own XML `Info.plist`. */
async function readArchivedApp(path: string): Promise<
  | {
      readonly bundleIdentifier: string;
      readonly version: string;
      readonly buildNumber: string;
    }
  | undefined
> {
  let document: PropertyListValue | undefined;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
    document = parsePropertyList(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  const properties = isDictionary(document) ? document.ApplicationProperties : undefined;
  if (!isDictionary(properties)) return undefined;
  const { CFBundleIdentifier, CFBundleShortVersionString, CFBundleVersion } = properties;
  if (
    typeof CFBundleIdentifier !== "string" ||
    typeof CFBundleShortVersionString !== "string" ||
    typeof CFBundleVersion !== "string"
  ) {
    return undefined;
  }
  return {
    bundleIdentifier: CFBundleIdentifier,
    version: CFBundleShortVersionString,
    buildNumber: CFBundleVersion,
  };
}

/** The one `.ipa` the export left, as a plain file; anything else is no package. */
async function onlyPackage(exportPath: string): Promise<string | undefined> {
  let names: ReadonlyArray<string>;
  try {
    names = (await readdir(exportPath)).filter((name) => name.endsWith(".ipa"));
  } catch {
    return undefined;
  }
  const [name] = names;
  if (name === undefined || names.length !== 1) return undefined;
  const path = join(exportPath, name);
  try {
    return (await lstat(path)).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What `altool --output-format json` answered: App Store Connect's delivery
 * identifier when it took the build, and its error messages otherwise.
 */
export function altoolAnswer(output: string): {
  readonly deliveryId?: string;
  readonly errors: ReadonlyArray<string>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { errors: [] };
  }
  const deliveryId = findString(parsed, "delivery-uuid");
  const errors: string[] = [];
  const productErrors = isRecord(parsed) ? parsed["product-errors"] : undefined;
  if (Array.isArray(productErrors)) {
    for (const error of productErrors) {
      const message = isRecord(error) ? error.message : undefined;
      if (typeof message === "string") errors.push(message);
    }
  }
  return {
    ...(deliveryId !== undefined && UUID.test(deliveryId)
      ? { deliveryId: deliveryId.toLowerCase() }
      : {}),
    errors,
  };
}

function findString(value: unknown, key: string, depth = 0): string | undefined {
  if (depth > 4 || !isRecord(value)) return undefined;
  const direct = value[key];
  if (typeof direct === "string") return direct;
  for (const nested of Object.values(value)) {
    const found = findString(nested, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function sameBuild(left: AppleUploadBuild, right: AppleUploadBuild): boolean {
  return (
    String(left.bundleIdentifier) === String(right.bundleIdentifier) &&
    String(left.version) === String(right.version) &&
    String(left.buildNumber) === String(right.buildNumber) &&
    String(left.signing.teamId) === String(right.signing.teamId) &&
    String(left.signing.identity) === String(right.signing.identity) &&
    left.profileId.toLowerCase() === right.profileId.toLowerCase()
  );
}

function refused(reason: "upload-changed"): AppleDeviceResponse {
  return decodeAppleDeviceResponse({ kind: "apple-device-refused", reason });
}

function succeeded(result: AppleProcessResult): boolean {
  return result.termination === "exited" && result.exitCode === 0 && !result.cleanupUncertain;
}

function outcomeFor(result: AppleProcessResult): AppleBuildOutcome {
  if (result.cleanupUncertain) return "interrupted";
  if (result.termination === "cancelled") return "cancelled";
  if (result.termination === "timed-out") return "timed-out";
  if (result.termination === "unavailable") return "unavailable";
  if (result.exitCode === null) return "process-died";
  return result.exitCode === 0 ? "succeeded" : "failed";
}

function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDictionary(value: PropertyListValue | undefined): value is PropertyListDictionary {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  );
}
