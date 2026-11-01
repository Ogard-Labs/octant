import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
  AggregateId,
  AggregateVersion,
  BROWSER_EXTENSION_EVENT_NAMES,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  decodeBrowserExtensionDisabled,
  decodeBrowserExtensionEnabled,
  decodeBrowserExtensionId,
  decodeBrowserExtensionInstalled,
  decodeBrowserExtensionRemoved,
  decodeBrowserExtensionUpdated,
  decodeBrowserExtensionsResult,
  type BrowserExtensionId,
  type BrowserExtensionRefusalReason,
  type ExtensionImportBrowserId,
  type BrowserExtensionsCommand,
  type BrowserExtensionsResult,
  type BrowserExtensionSummary,
  type EventActor as EventActorValue,
  type Project,
  type ProjectId,
  type StoredBrowserProfile,
  type WindowId,
} from "@octant/contracts";
import {
  browserExtensionsEnabledIn,
  browserProfileKey,
  readExtensionManifest,
  reduceBrowserExtensions,
  type BrowserExtensionEvent,
} from "@octant/domain";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import type { BrowserRuntimePort } from "./browserRuntimePort";
import {
  listInstalledExtensionSources,
  publicExtensionSources,
} from "./extensionImport/extensionImportSources";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventActor = Schema.decodeUnknownSync(EventActor);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export const BROWSER_EXTENSION_AGGREGATE = "browser-extension";
const EXTENSIONS_DIRECTORY = "browser-extensions";
const MAX_FILES = 5_000;
const MAX_BYTES = 64 * 1024 * 1024;

/** Who is asking. Only the person at a local window manages an extension. */
export type BrowserExtensionsCaller = "local-window" | "remote-device";

export interface BrowserExtensionServiceOptions {
  /** The host data directory; installed copies live under `browser-extensions/`. */
  readonly dataDirectory: string;
  readonly journal: Pick<Journal, "append" | "replayAggregateType" | "aggregateVersions">;
  readonly actor: EventActorValue;
  /** Turns the receipt a native folder picker issued into the folder it named. */
  readonly receipts: {
    readonly consume: (input: {
      readonly receiptId: string;
      readonly windowId: string;
      readonly now: number;
    }) => string | undefined;
  };
  readonly runtime: BrowserRuntimePort;
  /** The person's home folder, where other browsers keep their extensions; absent where none is offered. */
  readonly importHome?: string;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly now: () => number;
}

/** What the desktop app needs to load one enabled extension. */
export interface EnabledExtensionFolder {
  readonly id: BrowserExtensionId;
  readonly path: string;
  readonly contentHash: string;
}

/**
 * Browser extensions, installed and enabled by the person at a local window.
 *
 * The journal is the only record: installed and enabled state is rebuilt from
 * its events, so a restart and a replay agree. An agent, a plugin, a skill, and
 * a paired device have no route here; the service refuses any caller that is not
 * the person at a local window. Installing never enables, and an update that
 * asks for more access than the installed version turns the extension off
 * everywhere until the person confirms again.
 */
export class BrowserExtensionService {
  readonly #options: BrowserExtensionServiceOptions;

  constructor(options: BrowserExtensionServiceOptions) {
    this.#options = options;
  }

  /** The installed extensions and where each runs. */
  list(): ReadonlyArray<BrowserExtensionSummary> {
    return reduceBrowserExtensions(this.#events());
  }

  /**
   * Turns every extension off in a profile that is going away with its Project,
   * so a purged Project leaves nothing enabled and no profile waiting on a
   * confirmation. Each is journaled like any disable.
   */
  async forgetProfile(profile: StoredBrowserProfile): Promise<void> {
    const key = browserProfileKey(profile);
    for (const extension of this.list()) {
      const here = [...extension.enabledIn, ...extension.needsConfirmation].some(
        (entry) => browserProfileKey(entry) === key,
      );
      if (!here) continue;
      this.#append(
        extension.id,
        BROWSER_EXTENSION_EVENT_NAMES.disabled,
        decodeBrowserExtensionDisabled({
          kind: "browser-extension-disabled",
          extensionId: extension.id,
          profile,
        }),
      );
    }
    await this.#syncProfiles([profile]);
  }

  /** The folders of the extensions enabled in one profile, for the desktop app to load. */
  enabledFolders(profile: StoredBrowserProfile): ReadonlyArray<EnabledExtensionFolder> {
    return browserExtensionsEnabledIn(this.list(), profile).map((extension) => ({
      id: extension.id,
      path: this.#folderOf(extension.id),
      contentHash: extension.contentHash,
    }));
  }

  async execute(
    windowId: WindowId,
    caller: BrowserExtensionsCaller,
    command: BrowserExtensionsCommand,
  ): Promise<BrowserExtensionsResult> {
    // A paired device may see what is installed and where it runs; changing any of
    // it is the person's, at a window of this computer.
    // What another browser has installed is the person's business too.
    if (caller !== "local-window" && command.kind !== "list") {
      return refused("extension-not-local", "Browser extensions are managed only on this Mac.");
    }
    switch (command.kind) {
      case "list":
        return decodeBrowserExtensionsResult({
          kind: "browser-extensions",
          extensions: this.list(),
        });
      case "install":
        return this.#install(windowId, command.receiptId);
      case "import-sources":
        return decodeBrowserExtensionsResult({
          kind: "browser-extension-import-sources",
          sources:
            this.#options.importHome === undefined
              ? []
              : publicExtensionSources(listInstalledExtensionSources(this.#options.importHome)),
        });
      case "import":
        return this.#import(command.browser, command.sourceProfile, command.sourceExtensionId);
      case "enable":
        return this.#enable(command.extensionId, command.profile, command.contentHash);
      case "disable":
        return this.#disable(command.extensionId, command.profile);
      case "remove":
        return this.#remove(command.extensionId);
    }
  }

  async #install(windowId: WindowId, receiptId: string): Promise<BrowserExtensionsResult> {
    if ((await this.#options.runtime.nativeAvailable?.()) !== true) {
      return refused("extension-unsupported", "Extensions need the Octant app on this Mac.");
    }
    const folder = this.#options.receipts.consume({
      receiptId,
      windowId: String(windowId),
      now: this.#options.now(),
    });
    if (folder === undefined) {
      return refused("invalid", "Pick the extension folder again; that choice expired.");
    }
    let manifestText: string;
    try {
      manifestText = readFileSync(join(folder, "manifest.json"), "utf8");
    } catch {
      return refused("invalid", "That folder has no manifest.json.");
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      return refused("invalid", "The folder's manifest.json is not valid JSON.");
    }
    return this.#installFolder(folder, manifest, undefined);
  }

  /**
   * Copies an extension out of another browser's profile on the person's pick.
   * The pick must be one the listing offers, so a name from a window never
   * becomes a path; the extension then follows the same path as a picked folder
   * and starts off everywhere.
   */
  async #import(
    browser: ExtensionImportBrowserId,
    sourceProfile: string,
    sourceExtensionId: string,
  ): Promise<BrowserExtensionsResult> {
    if ((await this.#options.runtime.nativeAvailable?.()) !== true) {
      return refused("extension-unsupported", "Extensions need the Octant app on this Mac.");
    }
    const candidate =
      this.#options.importHome === undefined
        ? undefined
        : listInstalledExtensionSources(this.#options.importHome)
            .find((source) => source.browser === browser)
            ?.profiles.find((profile) => profile.id === sourceProfile)
            ?.extensions.find((extension) => extension.id === sourceExtensionId);
    if (candidate === undefined) {
      return refused("not-found", "That extension is not in that browser any more.");
    }
    if (candidate.unsupportedReason !== undefined) {
      return refused("extension-unsupported", candidate.unsupportedReason);
    }
    return this.#installFolder(candidate.folder, candidate.manifest, browser);
  }

  async #installFolder(
    folder: string,
    manifest: unknown,
    importedFrom: ExtensionImportBrowserId | undefined,
  ): Promise<BrowserExtensionsResult> {
    const decision = readExtensionManifest(manifest);
    if (decision.kind === "refused") return refused(decision.reason, decision.message);
    const facts = decision.facts;
    const extensionId = extensionIdFromName(facts.name);
    const staging = join(this.#directory(), `.staging-${this.#options.uuid()}`);
    let contentHash: string;
    try {
      mkdirSync(this.#directory(), { recursive: true, mode: 0o700 });
      contentHash = copyFolder(
        folder,
        staging,
        // A store copy carries the browser's own integrity files; they mean nothing here.
        importedFrom === undefined ? NO_SKIPPED_NAMES : BROWSER_PRIVATE_NAMES,
      );
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      return refused(
        "invalid",
        error instanceof FolderRefusal ? error.message : "That folder could not be copied.",
      );
    }
    const previous = this.list().find((extension) => extension.id === extensionId);
    const target = this.#folderOf(extensionId);
    try {
      const old = `${target}.old-${this.#options.uuid()}`;
      let displaced = false;
      try {
        renameSync(target, old);
        displaced = true;
      } catch {
        // Nothing was installed here before.
      }
      renameSync(staging, target);
      if (displaced) rmSync(old, { recursive: true, force: true });
    } catch {
      rmSync(staging, { recursive: true, force: true });
      return refused("invalid", "That folder could not be installed.");
    }
    const payload = {
      extensionId,
      name: facts.name,
      version: facts.version,
      contentHash,
      permissions: facts.access.permissions,
      hostPatterns: facts.access.hostPatterns,
      hasPopup: pageExists(target, facts.popupPage),
      hasOptionsPage: pageExists(target, facts.optionsPage),
      ...(importedFrom === undefined ? {} : { importedFrom }),
    };
    const updated = previous !== undefined;
    this.#append(
      extensionId,
      updated ? BROWSER_EXTENSION_EVENT_NAMES.updated : BROWSER_EXTENSION_EVENT_NAMES.installed,
      updated
        ? decodeBrowserExtensionUpdated({ kind: "browser-extension-updated", ...payload })
        : decodeBrowserExtensionInstalled({ kind: "browser-extension-installed", ...payload }),
    );
    const extension = this.#summary(extensionId);
    if (extension === undefined) return refused("invalid", "That folder could not be installed.");
    // An update changes the files, and a widened one turns profiles off: both
    // reach the desktop app's loaded copy.
    await this.#syncProfiles([
      ...(previous?.enabledIn ?? []),
      ...(previous?.needsConfirmation ?? []),
    ]);
    return decodeBrowserExtensionsResult({
      kind: "browser-extension-installed",
      extension,
      updated,
    });
  }

  async #enable(
    extensionId: BrowserExtensionId,
    profile: StoredBrowserProfile,
    contentHash: string,
  ): Promise<BrowserExtensionsResult> {
    const extension = this.#summary(extensionId);
    if (extension === undefined) return refused("not-found", "That extension is not installed.");
    if (extension.contentHash !== contentHash) {
      return refused("stale", "That extension changed since you looked at it. Look again.");
    }
    if ((await this.#options.runtime.nativeAvailable?.()) !== true) {
      return refused("extension-unsupported", "Extensions need the Octant app on this Mac.");
    }
    if (profile.kind === "project") {
      const project = this.#options.readProject(profile.projectId);
      if (project === undefined || project.type === "chat" || project.lifecycle !== "active") {
        return refused("not-found", "That Project is not available.");
      }
    }
    this.#append(
      extensionId,
      BROWSER_EXTENSION_EVENT_NAMES.enabled,
      decodeBrowserExtensionEnabled({
        kind: "browser-extension-enabled",
        extensionId,
        profile,
        contentHash,
      }),
    );
    await this.#syncProfiles([profile]);
    return this.#changed(extensionId);
  }

  async #disable(
    extensionId: BrowserExtensionId,
    profile: StoredBrowserProfile,
  ): Promise<BrowserExtensionsResult> {
    if (this.#summary(extensionId) === undefined) {
      return refused("not-found", "That extension is not installed.");
    }
    this.#append(
      extensionId,
      BROWSER_EXTENSION_EVENT_NAMES.disabled,
      decodeBrowserExtensionDisabled({ kind: "browser-extension-disabled", extensionId, profile }),
    );
    await this.#syncProfiles([profile]);
    return this.#changed(extensionId);
  }

  async #remove(extensionId: BrowserExtensionId): Promise<BrowserExtensionsResult> {
    const extension = this.#summary(extensionId);
    if (extension === undefined) return refused("not-found", "That extension is not installed.");
    this.#append(
      extensionId,
      BROWSER_EXTENSION_EVENT_NAMES.removed,
      decodeBrowserExtensionRemoved({ kind: "browser-extension-removed", extensionId }),
    );
    rmSync(this.#folderOf(extensionId), { recursive: true, force: true });
    await this.#syncProfiles([...extension.enabledIn, ...extension.needsConfirmation]);
    return decodeBrowserExtensionsResult({ kind: "browser-extension-removed", extensionId });
  }

  /** Brings the desktop app's loaded extensions for each profile in line with the journal. */
  async #syncProfiles(profiles: ReadonlyArray<StoredBrowserProfile>): Promise<void> {
    const sync = this.#options.runtime.profiles?.syncExtensions;
    if (sync === undefined) return;
    const seen = new Set<string>();
    for (const profile of profiles) {
      const key = browserProfileKey(profile);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await sync(profile, this.enabledFolders(profile));
      } catch {
        // The journal is the record. The desktop app loads the right set the
        // next time a page opens in this profile.
      }
    }
  }

  #changed(extensionId: BrowserExtensionId): BrowserExtensionsResult {
    const extension = this.#summary(extensionId);
    return extension === undefined
      ? refused("not-found", "That extension is not installed.")
      : decodeBrowserExtensionsResult({ kind: "browser-extension-changed", extension });
  }

  #summary(extensionId: BrowserExtensionId): BrowserExtensionSummary | undefined {
    return this.list().find((extension) => extension.id === extensionId);
  }

  #directory(): string {
    return join(this.#options.dataDirectory, EXTENSIONS_DIRECTORY);
  }

  #folderOf(extensionId: BrowserExtensionId): string {
    return join(this.#directory(), String(extensionId));
  }

  #events(): ReadonlyArray<BrowserExtensionEvent> {
    const events: BrowserExtensionEvent[] = [];
    let afterSequence = 0;
    for (;;) {
      const page = this.#options.journal.replayAggregateType({
        aggregateType: BROWSER_EXTENSION_AGGREGATE,
        afterSequence,
        limit: 1_000,
      });
      for (const event of page) {
        events.push({
          eventName: event.eventName,
          payload: event.payload,
        } as BrowserExtensionEvent);
        afterSequence = Math.max(afterSequence, event.globalSequence);
      }
      if (page.length < 1_000) return events;
    }
  }

  #append(extensionId: BrowserExtensionId, eventName: string, payload: unknown): void {
    const aggregateId = decodeAggregateId(aggregateUuid(extensionId));
    const current = this.#options.journal
      .aggregateVersions(BROWSER_EXTENSION_AGGREGATE)
      .find((row) => row.aggregateId === String(aggregateId));
    this.#options.journal.append({
      aggregate: { aggregateType: BROWSER_EXTENSION_AGGREGATE, aggregateId },
      expectedVersion: decodeAggregateVersion(current?.aggregateVersion ?? 0),
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName: decodeEventName(eventName),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor: decodeEventActor(this.#options.actor),
          occurredAt: decodeTimestamp(this.#options.clock()),
          payload,
        },
      ],
    });
  }
}

/** The one identity an extension has on this host: its name, so the same name updates it. */
export function extensionIdFromName(name: string): BrowserExtensionId {
  return decodeBrowserExtensionId(
    createHash("sha256")
      .update("octant.browser-extension.v1\0")
      .update(name.trim().toLowerCase())
      .digest("hex")
      .slice(0, 32),
  );
}

function aggregateUuid(extensionId: BrowserExtensionId): string {
  const hex = createHash("sha256")
    .update(`octant.browser-extension.aggregate\0${extensionId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

class FolderRefusal extends Error {}

const NO_SKIPPED_NAMES: ReadonlySet<string> = new Set();
const BROWSER_PRIVATE_NAMES: ReadonlySet<string> = new Set(["_metadata"]);

/** The first path segment of `path` under `source`, or "" for `source` itself. */
function relativeTopLevel(source: string, path: string): string {
  return relative(source, path).split(sep)[0] ?? "";
}

/**
 * Copies an extension folder and hashes what it copied.
 *
 * A symbolic link is refused rather than followed, so a folder cannot make the
 * copy reach a file outside it, and the folder is bounded in files and bytes. The
 * hash covers every path and byte, so two copies hash alike exactly when they are
 * the same extension.
 */
function copyFolder(
  source: string,
  destination: string,
  skippedTopLevel: ReadonlySet<string>,
): string {
  const files: string[] = [];
  let bytes = 0;
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(source, relative)).sort()) {
      if (relative === "" && skippedTopLevel.has(entry)) continue;
      const path = relative === "" ? entry : `${relative}/${entry}`;
      const info = lstatSync(join(source, path));
      if (info.isSymbolicLink())
        throw new FolderRefusal("An extension folder cannot contain links.");
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) {
        files.push(path);
        bytes += info.size;
        if (files.length > MAX_FILES || bytes > MAX_BYTES) {
          throw new FolderRefusal("That extension folder is larger than Octant will install.");
        }
      }
    }
  };
  walk("");
  const hash = createHash("sha256");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const path of files) {
    hash
      .update(path)
      .update("\0")
      .update(readFileSync(join(source, path)))
      .update("\0");
  }
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    filter: (path) => !skippedTopLevel.has(relativeTopLevel(source, path)),
  });
  return hash.digest("hex");
}

/** Whether the manifest's page is a file the installed copy holds. */
function pageExists(folder: string, page: string | undefined): boolean {
  return page !== undefined && existsAsFile(join(folder, page));
}

function existsAsFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function refused(reason: BrowserExtensionRefusalReason, message: string): BrowserExtensionsResult {
  return { kind: "browser-extension-refused", reason, message };
}
