import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProviderInstance } from "@octant/contracts";

import type { ProviderCredentialStore } from "./credentialBrokerClient";

const ENVELOPE_KIND = "claude-helper-sign-in";
const MARKER_FILE = "claude-helper-token-retirement.json";
/** Names what a finished pass covered, so a narrower earlier pass runs again. */
const MARKER_SCOPE = "live-and-removed-instances";

export type ClaudeHelperTokenRetirementOutcome =
  | { readonly status: "retired"; readonly deletedCount: number }
  | { readonly status: "already-retired" }
  | { readonly status: "unavailable" };

function isHelperEnvelope(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { readonly kind?: unknown }).kind === ENVELOPE_KIND
    );
  } catch {
    return false;
  }
}

async function alreadyRetired(path: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { readonly scope?: unknown }).scope === MARKER_SCOPE
    );
  } catch {
    return false;
  }
}

/**
 * Deletes the helper tokens an earlier Octant stored, once per data directory.
 *
 * The broker keeps one entry per provider instance and cannot list them, so
 * the pass asks for each Claude instance and for each removed instance:
 * removing a subscription account never cleared its entry, which left the
 * token in the host credential store with nothing able to reach it. Only an
 * entry that reads as a helper envelope is deleted, so an API key stays. A
 * broker failure writes no marker, and the next start tries again.
 */
export async function retireClaudeHelperTokens(input: {
  readonly dataDirectory: string;
  readonly broker: ProviderCredentialStore | undefined;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly removedInstanceIds: ReadonlyArray<string>;
}): Promise<ClaudeHelperTokenRetirementOutcome> {
  const path = join(input.dataDirectory, MARKER_FILE);
  if (await alreadyRetired(path)) return { status: "already-retired" };
  const broker = input.broker;
  if (broker === undefined) return { status: "unavailable" };
  const instanceIds = [
    ...input.instances
      .filter((instance) => instance.driverKind === "claude")
      .map((instance) => String(instance.id)),
    ...input.removedInstanceIds,
  ];
  let deletedCount = 0;
  try {
    for (const instanceId of instanceIds) {
      if (!(await broker.has(instanceId))) continue;
      if (!isHelperEnvelope(await broker.resolve(instanceId))) continue;
      await broker.delete(instanceId);
      deletedCount += 1;
    }
  } catch {
    return { status: "unavailable" };
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ scope: MARKER_SCOPE })}\n`, { mode: 0o600 });
  return { status: "retired", deletedCount };
}
