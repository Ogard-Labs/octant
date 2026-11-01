import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionImportBrowserId, ExtensionImportSource } from "@octant/contracts";
import { readExtensionManifest } from "@octant/domain";
import { browserDataDirectory, COOKIE_IMPORT_BROWSERS } from "../cookieImport/cookieImportBrowsers";
import { chromiumProfileFolders } from "../cookieImport/cookieImportSources";

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_EXTENSIONS_PER_PROFILE = 256;

/** An extension in another browser's profile, with the folder Octant would copy. */
export interface InstalledExtensionCandidate {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** The version folder inside the other browser's profile. It is copied, never loaded in place. */
  readonly folder: string;
  /** The manifest with its name made plain, ready for the same checks a picked folder gets. */
  readonly manifest: Record<string, unknown>;
  readonly unsupportedReason: string | undefined;
}

export interface InstalledExtensionSource {
  readonly browser: ExtensionImportBrowserId;
  readonly label: string;
  readonly profiles: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly extensions: ReadonlyArray<InstalledExtensionCandidate>;
  }>;
}

/**
 * The extensions installed in the Chromium-family browsers on this Mac, by
 * profile. Only each extension's manifest and its translated name are read: no
 * profile database, cookie, or extension script is opened, and the person picks
 * before anything is copied.
 */
export function listInstalledExtensionSources(
  home: string,
): ReadonlyArray<InstalledExtensionSource> {
  const sources: InstalledExtensionSource[] = [];
  for (const browser of COOKIE_IMPORT_BROWSERS) {
    if (browser.engine !== "chromium") continue;
    const directory = browserDataDirectory(home, browser);
    if (!existsSync(directory)) continue;
    const profiles = chromiumProfileFolders(directory)
      .map((profile) => ({
        ...profile,
        extensions: profileExtensions(join(directory, profile.id, "Extensions")),
      }))
      .filter((profile) => profile.extensions.length > 0);
    if (profiles.length > 0) {
      sources.push({
        browser: browser.id as ExtensionImportBrowserId,
        label: browser.label,
        profiles,
      });
    }
  }
  return sources;
}

/** The part of the listing a person sees; no folder path leaves the host. */
export function publicExtensionSources(
  installed: ReadonlyArray<InstalledExtensionSource>,
): ReadonlyArray<ExtensionImportSource> {
  return installed.map((source) => ({
    browser: source.browser,
    label: source.label,
    profiles: source.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      extensions: profile.extensions.map((extension) => ({
        id: extension.id,
        name: extension.name,
        version: extension.version,
        ...(extension.unsupportedReason === undefined
          ? {}
          : { unsupportedReason: extension.unsupportedReason }),
      })),
    })),
  }));
}

function profileExtensions(directory: string): ReadonlyArray<InstalledExtensionCandidate> {
  if (!isPlainDirectory(directory)) return [];
  let ids: string[];
  try {
    ids = readdirSync(directory).filter(
      (entry) => EXTENSION_ID_PATTERN.test(entry) && isPlainDirectory(join(directory, entry)),
    );
  } catch {
    return [];
  }
  const found: InstalledExtensionCandidate[] = [];
  for (const id of ids.sort()) {
    const candidate = candidateOf(id, join(directory, id));
    if (candidate !== undefined) found.push(candidate);
    if (found.length >= MAX_EXTENSIONS_PER_PROFILE) break;
  }
  return found;
}

function candidateOf(id: string, idDirectory: string): InstalledExtensionCandidate | undefined {
  // A browser keeps one folder per installed version, such as `1.2.3_0`; the
  // newest is the one it runs.
  let versions: string[];
  try {
    versions = readdirSync(idDirectory)
      .filter((entry) => isPlainDirectory(join(idDirectory, entry)))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  } catch {
    return undefined;
  }
  const versionFolder = versions.at(-1);
  if (versionFolder === undefined) return undefined;
  const folder = join(idDirectory, versionFolder);
  const manifest = readManifest(folder);
  if (manifest === undefined) return undefined;
  const name = plainName(folder, manifest);
  const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  if (name === undefined || version === "") return undefined;
  const plain = { ...manifest, name };
  return {
    id,
    name,
    version,
    folder,
    manifest: plain,
    unsupportedReason: unsupportedReason(plain),
  };
}

function unsupportedReason(manifest: Record<string, unknown>): string | undefined {
  if (manifest.manifest_version !== 3) {
    return "It uses the older Manifest V2 format, which Octant cannot run.";
  }
  const decision = readExtensionManifest(manifest);
  if (decision.kind === "valid") return undefined;
  const asksForNativeMessaging = [manifest.permissions, manifest.optional_permissions].some(
    (list) => Array.isArray(list) && list.includes("nativeMessaging"),
  );
  return asksForNativeMessaging
    ? "It needs to talk to a program on your Mac (native messaging), which Octant does not support."
    : "Its manifest is not one Octant can read.";
}

function readManifest(folder: string): Record<string, unknown> | undefined {
  return readJsonObject(join(folder, "manifest.json"));
}

/**
 * The name a person would see. A store extension usually names itself with a
 * message key (`__MSG_appName__`) that its own `_locales` folder translates.
 */
function plainName(folder: string, manifest: Record<string, unknown>): string | undefined {
  const raw = typeof manifest.name === "string" ? manifest.name.trim() : "";
  const key = /^__MSG_(.+)__$/.exec(raw)?.[1];
  if (key === undefined) return raw === "" ? undefined : raw;
  const defaultLocale =
    typeof manifest.default_locale === "string" ? [manifest.default_locale] : [];
  for (const locale of [...defaultLocale, "en", "en_US"]) {
    if (!/^[A-Za-z_-]{2,16}$/.test(locale)) continue;
    const messages = readJsonObject(join(folder, "_locales", locale, "messages.json"));
    const entry = Object.entries(messages ?? {}).find(
      ([name]) => name.toLowerCase() === key.toLowerCase(),
    );
    const message = (entry?.[1] as { message?: unknown } | undefined)?.message;
    if (typeof message === "string" && message.trim() !== "") return message.trim();
  }
  return undefined;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isPlainDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
