import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Which npm registry a package comes from, as the person's own npm
 * configuration names it: the `npm_config_registry` variable, then the user
 * `.npmrc`'s scoped `@scope:registry`, then its `registry`, then the public
 * registry. Only registry addresses are read. A token or any other setting in
 * those files is never read, kept, or sent, so a registry that needs a login
 * answers as refused.
 */

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";

export type NpmRegistryChoice =
  | { readonly status: "chosen"; readonly registry: string }
  | { readonly status: "unreadable" }
  | { readonly status: "insecure" };

export interface NpmRegistryConfigSources {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The text of the user's `.npmrc`, when there is one. */
  readonly userConfigText?: string | undefined;
}

export function chooseNpmRegistry(
  packageName: string,
  sources: NpmRegistryConfigSources,
): NpmRegistryChoice {
  const scope = packageName.startsWith("@") ? packageName.slice(0, packageName.indexOf("/")) : "";
  const settings = parseNpmrcRegistrySettings(sources.userConfigText ?? "");
  const fromEnvironment = (
    sources.env.npm_config_registry ??
    sources.env.NPM_CONFIG_REGISTRY ??
    ""
  ).trim();
  const raw =
    fromEnvironment !== ""
      ? fromEnvironment
      : ((scope === "" ? undefined : settings.get(`${scope}:registry`)) ??
        settings.get("registry") ??
        PUBLIC_NPM_REGISTRY);
  // A value written with `${NAME}` is expanded by npm from the environment.
  // Guessing at it could send a private package name to the public registry.
  if (raw.includes("${")) return { status: "unreadable" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { status: "unreadable" };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    return { status: "unreadable" };
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return { status: "insecure" };
  url.search = "";
  url.hash = "";
  return { status: "chosen", registry: url.toString().replace(/\/+$/, "") };
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseNpmrcRegistrySettings(text: string): ReadonlyMap<string, string> {
  const settings = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (key !== "registry" && !/^@[^:\s]+:registry$/.test(key)) continue;
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (value !== "") settings.set(key, value);
  }
  return settings;
}

/** Reads the user's `.npmrc` named by `npm_config_userconfig`, or `~/.npmrc`; absent means none. */
export async function readUserNpmConfig(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const path = (env.npm_config_userconfig ?? env.NPM_CONFIG_USERCONFIG ?? "").trim();
  try {
    return await readFile(path === "" ? join(home, ".npmrc") : path, "utf8");
  } catch {
    return undefined;
  }
}
