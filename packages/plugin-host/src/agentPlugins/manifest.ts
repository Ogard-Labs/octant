import type { AgentPluginsDiagnostic } from "./constants";
import { AGENT_PLUGINS_NAME_PATTERN, AGENT_PLUGINS_PLUGIN_SCHEMA } from "./constants";
import { asRecord, fail, isRecord } from "./errors";

const PERMITTED_MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

export interface AgentPluginsAuthor {
  readonly name?: string;
  readonly email?: string;
  readonly url?: string;
}

export interface AgentPluginsManifest {
  readonly $schema: typeof AGENT_PLUGINS_PLUGIN_SCHEMA;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: AgentPluginsAuthor;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: ReadonlyArray<string>;
  readonly extensions?: Readonly<Record<string, Record<string, unknown>>>;
}

export interface AgentPluginsManifestResult {
  readonly manifest: AgentPluginsManifest;
  readonly diagnostics: ReadonlyArray<AgentPluginsDiagnostic>;
}

/**
 * Validate a closed Agent Plugins plugin.json object.
 * Non-fatal: unknown top-level fields; non-object extensions.
 * Fatal: missing/unsupported $schema, invalid name, other schema violations.
 */
export function validateAgentPluginsManifest(raw: unknown): AgentPluginsManifestResult {
  const diagnostics: AgentPluginsDiagnostic[] = [];
  const record = asRecord(raw, "manifest-invalid", "plugin.json must be a JSON object.");

  const schema = record.$schema;
  if (schema !== AGENT_PLUGINS_PLUGIN_SCHEMA) {
    fail(
      "manifest-schema",
      "plugin.json $schema must identify a locally supported Agent Plugins version.",
    );
  }

  const name = record.name;
  if (typeof name !== "string" || name.length < 1 || name.length > 64) {
    fail("manifest-name", "plugin.json name is required and must be 1–64 characters.");
  }
  if (!AGENT_PLUGINS_NAME_PATTERN.test(name)) {
    fail("manifest-name", "plugin.json name does not match the Agent Plugins name pattern.");
  }

  for (const key of Object.keys(record)) {
    if (!PERMITTED_MANIFEST_FIELDS.has(key)) {
      diagnostics.push({
        code: "unknown-field",
        severity: "warning",
        message: `Ignoring unknown top-level field "${key}".`,
        path: key,
      });
    }
  }

  for (const field of ["version", "description", "homepage", "repository", "license"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      fail("manifest-field", `plugin.json ${field} must be a string when present.`);
    }
  }

  if (record.extensions !== undefined) {
    if (!isRecord(record.extensions)) {
      diagnostics.push({
        code: "extensions-ignored",
        severity: "warning",
        message: "Ignoring non-object extensions field.",
        path: "extensions",
      });
    } else {
      for (const [namespace, value] of Object.entries(record.extensions)) {
        if (!isRecord(value)) {
          diagnostics.push({
            code: "extension-namespace-ignored",
            severity: "warning",
            message: `Ignoring non-object extension namespace "${namespace}".`,
            path: `extensions.${namespace}`,
          });
          continue;
        }
        diagnostics.push({
          code: "extension-namespace-unimplemented",
          severity: "info",
          message: `Ignoring unimplemented extension namespace "${namespace}".`,
          path: `extensions.${namespace}`,
        });
      }
    }
  }

  const author = parseAuthor(record.author);
  const keywords = parseKeywords(record.keywords);
  const version = optionalStringField(record, "version");
  const description = optionalStringField(record, "description");
  const homepage = optionalStringField(record, "homepage");
  const repository = optionalStringField(record, "repository");
  const license = optionalStringField(record, "license");

  return {
    manifest: {
      $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
      name,
      ...(version === undefined ? {} : { version }),
      ...(description === undefined ? {} : { description }),
      ...(author === undefined ? {} : { author }),
      ...(homepage === undefined ? {} : { homepage }),
      ...(repository === undefined ? {} : { repository }),
      ...(license === undefined ? {} : { license }),
      ...(keywords === undefined ? {} : { keywords }),
    },
    diagnostics,
  };
}

function optionalStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    fail("manifest-field-type", `plugin.json ${field} must be a string when present.`);
  }
  return value;
}

function parseAuthor(value: unknown): AgentPluginsAuthor | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    fail("manifest-author", "plugin.json author must be an object when present.");
  }
  const allowed = new Set(["name", "email", "url"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("manifest-author", `plugin.json author contains unknown field "${key}".`);
    }
    if (value[key] !== undefined && typeof value[key] !== "string") {
      fail("manifest-author", `plugin.json author.${key} must be a string.`);
    }
  }
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
  };
}

function parseKeywords(value: unknown): ReadonlyArray<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail("manifest-keywords", "plugin.json keywords must be an array of strings.");
  }
  return value as string[];
}

/** Detect whether a raw JSON value is an Agent Plugins plugin.json document. */
export function isAgentPluginsManifest(raw: unknown): boolean {
  return isRecord(raw) && raw.$schema === AGENT_PLUGINS_PLUGIN_SCHEMA;
}
