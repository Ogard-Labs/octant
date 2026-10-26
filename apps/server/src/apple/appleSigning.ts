import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeAppleSigningIdentityFingerprint,
  type AppleBundleIdentifier,
  type AppleSigningIdentityFingerprint,
  type AppleTeamId,
} from "@octant/contracts";
import type { AppleProvisioningProfileFacts } from "@octant/domain";
import { readStoredFile } from "./appleRuntimeStore";

// Development signing material, read the way decision 1 of
// docs/design/apple-devices.md allows: the identities the person's login
// keychain already holds, named by fingerprint, and the provisioning profiles
// Xcode already installed. No private key, `.p12`, or keychain item is read
// here; the keychain is reached only by the host's own `security` and
// `codesign` launches.

export type PropertyListValue =
  | string
  | number
  | boolean
  | Date
  | Uint8Array
  | ReadonlyArray<PropertyListValue>
  | PropertyListDictionary;
export interface PropertyListDictionary {
  readonly [key: string]: PropertyListValue;
}

const MAX_PROPERTY_LIST_DEPTH = 32;
const MAX_PROPERTY_LIST_TOKENS = 200_000;

type Token =
  | { readonly kind: "open"; readonly name: string }
  | { readonly kind: "close"; readonly name: string }
  | { readonly kind: "empty"; readonly name: string }
  | { readonly kind: "text"; readonly value: string };

/**
 * Reads an XML property list, the form a provisioning profile carries. Only
 * the element types Apple defines are accepted; anything else, or a document
 * deeper or longer than any profile, is unreadable.
 */
export function parsePropertyList(xml: string): PropertyListValue | undefined {
  const tokens = tokenize(xml);
  if (tokens === undefined) return undefined;
  const cursor = { index: 0 };
  const opening = tokens[cursor.index];
  if (opening?.kind !== "open" || opening.name !== "plist") return undefined;
  cursor.index += 1;
  try {
    const value = readValue(tokens, cursor, 0);
    const closing = tokens[cursor.index];
    if (closing?.kind !== "close" || closing.name !== "plist") return undefined;
    return cursor.index + 1 === tokens.length ? value : undefined;
  } catch {
    return undefined;
  }
}

function tokenize(xml: string): ReadonlyArray<Token> | undefined {
  const body = xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "");
  const tokens: Token[] = [];
  const pattern = /<(\/?)([A-Za-z]+)(?:\s[^<>]*?)?\s*(\/?)>|([^<]+)|(<)/g;
  for (const match of body.matchAll(pattern)) {
    if (tokens.length >= MAX_PROPERTY_LIST_TOKENS || match[5] !== undefined) return undefined;
    const text = match[4];
    if (text !== undefined) {
      tokens.push({ kind: "text", value: text });
      continue;
    }
    const name = match[2] ?? "";
    tokens.push(
      match[1] === "/"
        ? { kind: "close", name }
        : match[3] === "/"
          ? { kind: "empty", name }
          : { kind: "open", name },
    );
  }
  // Whitespace between elements is layout; inside a string it is kept below.
  return tokens.filter((token, index) => {
    if (token.kind !== "text" || token.value.trim().length > 0) return true;
    const previous = tokens[index - 1];
    return previous?.kind === "open" && previous.name === "string";
  });
}

function readValue(
  tokens: ReadonlyArray<Token>,
  cursor: { index: number },
  depth: number,
): PropertyListValue {
  if (depth > MAX_PROPERTY_LIST_DEPTH) throw new Error("too deep");
  const token = tokens[cursor.index];
  cursor.index += 1;
  if (token?.kind === "empty") {
    if (token.name === "true") return true;
    if (token.name === "false") return false;
    if (token.name === "string") return "";
    if (token.name === "array") return [];
    if (token.name === "dict") return {};
    if (token.name === "data") return new Uint8Array();
    throw new Error("unexpected element");
  }
  if (token?.kind !== "open") throw new Error("expected a value");
  switch (token.name) {
    case "dict": {
      const entries: Array<readonly [string, PropertyListValue]> = [];
      while (!closes(tokens[cursor.index], "dict")) {
        const key = readText(tokens, cursor, "key");
        entries.push([key, readValue(tokens, cursor, depth + 1)]);
      }
      cursor.index += 1;
      return Object.fromEntries(entries);
    }
    case "array": {
      const items: PropertyListValue[] = [];
      while (!closes(tokens[cursor.index], "array")) {
        items.push(readValue(tokens, cursor, depth + 1));
      }
      cursor.index += 1;
      return items;
    }
    case "true":
    case "false":
      expectClose(tokens, cursor, token.name);
      return token.name === "true";
    default: {
      cursor.index -= 1;
      const text = readText(tokens, cursor, token.name);
      if (token.name === "string") return text;
      if (token.name === "integer" && /^[+-]?\d+$/.test(text.trim())) {
        return Number.parseInt(text.trim(), 10);
      }
      if (token.name === "real" && Number.isFinite(Number(text.trim()))) {
        return Number(text.trim());
      }
      if (token.name === "date" && !Number.isNaN(Date.parse(text.trim()))) {
        return new Date(text.trim());
      }
      if (token.name === "data" && /^[A-Za-z0-9+/=\s]*$/.test(text)) {
        return new Uint8Array(Buffer.from(text.replace(/\s+/g, ""), "base64"));
      }
      throw new Error("unexpected element");
    }
  }
}

function readText(tokens: ReadonlyArray<Token>, cursor: { index: number }, name: string): string {
  const open = tokens[cursor.index];
  if (open?.kind === "empty" && open.name === name) {
    cursor.index += 1;
    return "";
  }
  if (open?.kind !== "open" || open.name !== name) throw new Error(`expected ${name}`);
  cursor.index += 1;
  const next = tokens[cursor.index];
  let value = "";
  if (next?.kind === "text") {
    value = decodeEntities(next.value);
    cursor.index += 1;
  }
  expectClose(tokens, cursor, name);
  return value;
}

function closes(token: Token | undefined, name: string): boolean {
  if (token === undefined) throw new Error("unterminated");
  return token.kind === "close" && token.name === name;
}

function expectClose(tokens: ReadonlyArray<Token>, cursor: { index: number }, name: string): void {
  if (!closes(tokens[cursor.index], name)) throw new Error(`expected </${name}>`);
  cursor.index += 1;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g, (_entity, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name] ?? "";
  });
}

/** Writes an entitlements dictionary as the XML property list `codesign` reads. */
export function serializePropertyList(value: PropertyListDictionary): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    serializeValue(value),
    "</plist>",
    "",
  ].join("\n");
}

function serializeValue(value: PropertyListValue): string {
  if (typeof value === "string") return `<string>${escapeText(value)}</string>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "number") {
    return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
  }
  if (value instanceof Date) return `<date>${value.toISOString().replace(/\.\d{3}Z$/, "Z")}</date>`;
  if (value instanceof Uint8Array) return `<data>${Buffer.from(value).toString("base64")}</data>`;
  if (Array.isArray(value)) {
    return `<array>${(value as ReadonlyArray<PropertyListValue>).map(serializeValue).join("")}</array>`;
  }
  const entries = Object.entries(value as PropertyListDictionary);
  return `<dict>${entries
    .map(([key, item]) => `<key>${escapeText(key)}</key>${serializeValue(item)}`)
    .join("")}</dict>`;
}

function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The property list a `.mobileprovision` file signs. The file is a CMS
 * envelope whose content is that XML, carried unencrypted; the host takes the
 * XML without verifying the envelope, because the device verifies the profile
 * embedded in the app when it installs it, and an altered one is refused there.
 */
export function provisioningProfilePropertyList(bytes: Uint8Array): string | undefined {
  const text = Buffer.from(bytes).toString("latin1");
  const start = text.indexOf("<?xml");
  const end = text.indexOf("</plist>", start);
  if (start < 0 || end < 0) return undefined;
  const xml = Buffer.from(text.slice(start, end + "</plist>".length), "latin1");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(xml);
  } catch {
    return undefined;
  }
}

/** One installed provisioning profile, as the host may use it to sign. */
export interface HeldProvisioningProfile {
  readonly facts: AppleProvisioningProfileFacts;
  /** Where the profile is, so the host can embed it in the app it signs. */
  readonly path: string;
  readonly entitlements: PropertyListDictionary;
}

const MAX_PROFILES = 512;
const MAX_PROFILE_BYTES = 1024 * 1024;
const PROFILE_EXTENSION = ".mobileprovision";

/**
 * The provisioning profiles Xcode installed in these directories. A profile
 * that is not a plain file, is larger than any real one, or does not read as
 * a profile is left out; a directory that is missing has none.
 */
export async function readProvisioningProfiles(
  directories: ReadonlyArray<string>,
): Promise<ReadonlyArray<HeldProvisioningProfile>> {
  const profiles: HeldProvisioningProfile[] = [];
  for (const directory of directories) {
    let names: ReadonlyArray<string>;
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(PROFILE_EXTENSION)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (profiles.length >= MAX_PROFILES) return profiles;
      const path = join(directory, name);
      try {
        if (!(await lstat(path)).isFile()) continue;
        const bytes = await readStoredFile(path, MAX_PROFILE_BYTES);
        const profile = bytes === undefined ? undefined : provisioningProfile(bytes, path);
        if (profile !== undefined) profiles.push(profile);
      } catch {
        // A profile that cannot be read is one the host does not sign with.
      }
    }
  }
  return profiles;
}

export function provisioningProfile(
  bytes: Uint8Array,
  path: string,
): HeldProvisioningProfile | undefined {
  const xml = provisioningProfilePropertyList(bytes);
  const document = xml === undefined ? undefined : parsePropertyList(xml);
  if (!isDictionary(document)) return undefined;
  const entitlements = document.Entitlements;
  const expiration = document.ExpirationDate;
  const certificates = document.DeveloperCertificates;
  if (!isDictionary(entitlements) || !(expiration instanceof Date)) return undefined;
  const applicationIdentifier = entitlements["application-identifier"];
  if (typeof applicationIdentifier !== "string") return undefined;
  const profileId = typeof document.UUID === "string" ? document.UUID : path;
  return {
    path,
    entitlements,
    facts: {
      profileId,
      teamIds: strings(document.TeamIdentifier),
      platforms: strings(document.Platform),
      applicationIdentifier,
      getTaskAllow: entitlements["get-task-allow"] === true,
      provisionsAllDevices: document.ProvisionsAllDevices === true,
      expiresAtMs: expiration.getTime(),
      certificates: Array.isArray(certificates)
        ? (certificates as ReadonlyArray<PropertyListValue>).flatMap((certificate) =>
            certificate instanceof Uint8Array ? [certificateFingerprint(certificate)] : [],
          )
        : [],
    },
  };
}

/** A certificate's SHA-1 fingerprint, the form `security find-identity` names it by. */
export function certificateFingerprint(der: Uint8Array): AppleSigningIdentityFingerprint {
  return decodeAppleSigningIdentityFingerprint(
    createHash("sha1").update(der).digest("hex").toUpperCase(),
  );
}

/**
 * The valid code-signing identities `security find-identity -v -p
 * codesigning` lists, by fingerprint, in the keychain's order. The quoted name
 * beside each carries the person's name and is never kept.
 */
export function parseSigningIdentities(
  output: string,
): ReadonlyArray<AppleSigningIdentityFingerprint> {
  const identities: AppleSigningIdentityFingerprint[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"/.exec(line);
    const fingerprint = match?.[1]?.toUpperCase();
    if (fingerprint === undefined) continue;
    const identity = decodeAppleSigningIdentityFingerprint(fingerprint);
    if (!identities.some((known) => String(known) === String(identity))) identities.push(identity);
  }
  return identities;
}

/**
 * The entitlements an app is signed with: the profile's own (decision 2),
 * with a wildcard app ID narrowed to this app, since a device refuses a
 * signature whose app ID is a pattern.
 */
export function developmentEntitlements(
  profile: HeldProvisioningProfile,
  teamId: AppleTeamId,
  bundleIdentifier: AppleBundleIdentifier,
): PropertyListDictionary {
  return {
    ...profile.entitlements,
    "application-identifier": `${teamId}.${bundleIdentifier}`,
  };
}

function strings(value: PropertyListValue | undefined): ReadonlyArray<string> {
  return Array.isArray(value)
    ? (value as ReadonlyArray<PropertyListValue>).flatMap((item) =>
        typeof item === "string" ? [item] : [],
      )
    : [];
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
