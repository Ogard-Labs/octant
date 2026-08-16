import { fail, isRecord, asRecord } from "./errors";
import type { AgentPluginsDiagnostic } from "./constants";

/**
 * Resolve a package-relative path against a virtual plugin root of entries.
 * Rejects escapes, empty segments, backslashes, and absolute paths.
 */
export function normalizePackageRelativePath(value: string): string {
  if (value.length === 0 || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    fail("unsafe-path", "Package path is unsafe.");
  }
  const trimmed = value.replace(/\/+$/, "");
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail("unsafe-path", "Package path escapes the plugin root.");
  }
  return segments.join("/");
}

/** Plugin-relative paths in Agent Plugins configuration must begin with `./`. */
export function requirePluginRelativePath(value: string): string {
  if (!value.startsWith("./")) {
    fail("unsafe-path", "Plugin-relative paths must begin with ./.");
  }
  return normalizePackageRelativePath(value.slice(2));
}

export function resolveWithinRoot(root: string, relative: string): string {
  const normalizedRoot = root.replace(/\/+$/, "");
  const joined = `${normalizedRoot}/${normalizePackageRelativePath(relative)}`;
  if (normalizedRoot.length === 0) fail("unsafe-path", "Plugin root is invalid.");
  if (!joined.startsWith(`${normalizedRoot}/`) && joined !== normalizedRoot) {
    fail("unsafe-path", "Resolved path escapes the plugin root.");
  }
  return joined;
}

const PLACEHOLDER_PATTERN = /\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g;

/**
 * Expand only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` once. Non-recursive.
 * Does not apply to command, URLs, headers, or environment keys.
 */
export function expandPluginPlaceholders(
  value: string,
  variables: { readonly PLUGIN_ROOT: string; readonly PLUGIN_DATA: string },
): string {
  return value.replace(PLACEHOLDER_PATTERN, (_match, name: "PLUGIN_ROOT" | "PLUGIN_DATA") => {
    return variables[name];
  });
}

/**
 * Validate and resolve cwd for stdio servers.
 * Default is PLUGIN_ROOT. Explicit values must be plugin-relative, PLUGIN_ROOT-
 * rooted, or PLUGIN_DATA-rooted, and remain within that root after expansion.
 */
export function resolveStdioCwd(
  cwd: string | undefined,
  variables: { readonly PLUGIN_ROOT: string; readonly PLUGIN_DATA: string },
): string {
  if (cwd === undefined || cwd === "" || cwd === "${PLUGIN_ROOT}") {
    return variables.PLUGIN_ROOT;
  }
  if (cwd.startsWith("./")) {
    const relative = requirePluginRelativePath(cwd);
    return resolveWithinRoot(variables.PLUGIN_ROOT, relative);
  }
  if (cwd === "${PLUGIN_DATA}" || cwd.startsWith("${PLUGIN_DATA}/")) {
    const expanded = expandPluginPlaceholders(cwd, variables);
    assertUnderRoot(expanded, variables.PLUGIN_DATA);
    return expanded;
  }
  if (cwd.startsWith("${PLUGIN_ROOT}/")) {
    const expanded = expandPluginPlaceholders(cwd, variables);
    assertUnderRoot(expanded, variables.PLUGIN_ROOT);
    return expanded;
  }
  fail("mcp-cwd-invalid", "stdio cwd must be plugin-relative or PLUGIN_ROOT/PLUGIN_DATA rooted.");
}

function assertUnderRoot(path: string, root: string): void {
  const normalizedRoot = root.replace(/\/+$/, "");
  if (path !== normalizedRoot && !path.startsWith(`${normalizedRoot}/`)) {
    fail("unsafe-path", "Resolved working directory escapes its permitted root.");
  }
  const relative = path === normalizedRoot ? "" : path.slice(normalizedRoot.length + 1);
  if (relative.split("/").some((segment) => segment === "..")) {
    fail("unsafe-path", "Resolved working directory escapes its permitted root.");
  }
}

/** Resolve stdio command: bare token or ./ plugin-relative path. */
export function resolveStdioCommand(
  command: string,
  pluginRoot: string,
): { readonly kind: "bare" | "plugin-relative"; readonly executable: string } {
  if (command.length === 0 || command.includes("\0") || /\s/.test(command)) {
    fail("mcp-command-invalid", "stdio command must be a single executable token.");
  }
  if (command.startsWith("./")) {
    const relative = requirePluginRelativePath(command);
    return { kind: "plugin-relative", executable: resolveWithinRoot(pluginRoot, relative) };
  }
  if (command.startsWith("/") || command.includes("/") || command.includes("\\")) {
    fail("mcp-command-invalid", "stdio command must be a bare name or ./ plugin-relative path.");
  }
  return { kind: "bare", executable: command };
}

export function diagnostic(
  code: string,
  severity: AgentPluginsDiagnostic["severity"],
  message: string,
  path?: string,
): AgentPluginsDiagnostic {
  return path === undefined ? { code, severity, message } : { code, severity, message, path };
}

export { asRecord, fail, isRecord };
