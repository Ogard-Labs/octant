import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CookieImportSource } from "@octant/contracts";
import {
  browserDataDirectory,
  COOKIE_IMPORT_BROWSERS,
  type CookieImportBrowserDefinition,
} from "./cookieImportBrowsers";

/** A profile of an installed browser, with where its cookie database lives. */
export interface InstalledCookieSourceProfile {
  readonly id: string;
  readonly label: string;
  readonly cookiePath: string;
}

export interface InstalledCookieSource {
  readonly browser: CookieImportBrowserDefinition;
  readonly profiles: ReadonlyArray<InstalledCookieSourceProfile>;
}

// A profile id becomes part of a path, so it is held to names a browser makes.
const PROFILE_ID_PATTERN = /^[A-Za-z0-9 _.\-/]{1,128}$/;

function safeProfileId(id: string): boolean {
  return PROFILE_ID_PATTERN.test(id) && !id.split("/").includes("..") && !id.startsWith("/");
}

/**
 * The browsers installed on this Mac and the profiles each holds a cookie
 * database for. Nothing is read from a database here: a person sees a name, not
 * a cookie, and chooses before anything is opened.
 */
export function listInstalledCookieSources(home: string): ReadonlyArray<InstalledCookieSource> {
  const sources: InstalledCookieSource[] = [];
  for (const browser of COOKIE_IMPORT_BROWSERS) {
    const directory = browserDataDirectory(home, browser);
    if (!existsSync(directory)) continue;
    const profiles =
      browser.engine === "chromium" ? chromiumProfiles(directory) : firefoxProfiles(directory);
    if (profiles.length > 0) sources.push({ browser, profiles });
  }
  return sources;
}

/** The part of the listing a person sees. */
export function publicCookieSources(
  installed: ReadonlyArray<InstalledCookieSource>,
): ReadonlyArray<CookieImportSource> {
  return installed.map((source) => ({
    browser: source.browser.id,
    label: source.browser.label,
    profiles: source.profiles.map((profile) => ({ id: profile.id, label: profile.label })),
  }));
}

function chromiumProfiles(directory: string): ReadonlyArray<InstalledCookieSourceProfile> {
  const names = new Map<string, string>();
  try {
    const state: unknown = JSON.parse(readFileSync(join(directory, "Local State"), "utf8"));
    const cache = (state as { profile?: { info_cache?: Record<string, { name?: unknown }> } })
      .profile?.info_cache;
    for (const [id, info] of Object.entries(cache ?? {})) {
      names.set(id, typeof info?.name === "string" && info.name !== "" ? info.name : id);
    }
  } catch {
    // Without Local State the folders themselves are the profiles.
  }
  let folders: string[] = [...names.keys()];
  if (folders.length === 0) {
    try {
      folders = readdirSync(directory).filter(
        (entry) => entry === "Default" || /^Profile \d+$/.test(entry),
      );
    } catch {
      return [];
    }
  }
  const profiles: InstalledCookieSourceProfile[] = [];
  for (const id of folders) {
    if (!safeProfileId(id)) continue;
    const cookiePath = [
      join(directory, id, "Network", "Cookies"),
      join(directory, id, "Cookies"),
    ].find((candidate) => existsSync(candidate));
    if (cookiePath !== undefined) profiles.push({ id, label: names.get(id) ?? id, cookiePath });
  }
  return profiles;
}

function firefoxProfiles(directory: string): ReadonlyArray<InstalledCookieSourceProfile> {
  let ini: string;
  try {
    ini = readFileSync(join(directory, "profiles.ini"), "utf8");
  } catch {
    return [];
  }
  const profiles: InstalledCookieSourceProfile[] = [];
  for (const section of ini.split(/\r?\n\s*\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of section.split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (separator > 0)
        fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
    const path = fields.get("Path");
    if (
      path === undefined ||
      !/^\[Profile\d+\]/m.test(section) ||
      fields.get("IsRelative") !== "1"
    ) {
      continue;
    }
    if (!safeProfileId(path)) continue;
    const cookiePath = join(directory, path, "cookies.sqlite");
    if (existsSync(cookiePath)) {
      profiles.push({ id: path, label: fields.get("Name") ?? path, cookiePath });
    }
  }
  return profiles;
}
