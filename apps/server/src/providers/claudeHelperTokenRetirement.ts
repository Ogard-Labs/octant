import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProviderInstance } from "@octant/contracts";

import type { ProviderCredentialStore } from "./credentialBrokerClient";

const ENVELOPE_KIND = "claude-helper-sign-in";
const NOTICE_FILE = "claude-helper-token-retirement.json";

export interface ClaudeHelperTokenRetirementNotice {
  readonly deletedCount: number;
  readonly acknowledged: boolean;
}

export interface ClaudeHelperTokenRetirementStore {
  readonly notice: () => Promise<ClaudeHelperTokenRetirementNotice | undefined>;
  readonly retire: (
    instances: ReadonlyArray<ProviderInstance>,
  ) => Promise<ClaudeHelperTokenRetirementNotice | undefined>;
  readonly acknowledge: () => Promise<void>;
}

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

export function createClaudeHelperTokenRetirementStore(input: {
  readonly dataDirectory: string;
  readonly broker?: ProviderCredentialStore;
}): ClaudeHelperTokenRetirementStore {
  const path = join(input.dataDirectory, NOTICE_FILE);
  const readNotice = async (): Promise<ClaudeHelperTokenRetirementNotice | undefined> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        typeof (parsed as { deletedCount?: unknown }).deletedCount !== "number" ||
        typeof (parsed as { acknowledged?: unknown }).acknowledged !== "boolean"
      ) {
        return undefined;
      }
      return {
        deletedCount: (parsed as { deletedCount: number }).deletedCount,
        acknowledged: (parsed as { acknowledged: boolean }).acknowledged,
      };
    } catch {
      return undefined;
    }
  };
  const writeNotice = async (notice: ClaudeHelperTokenRetirementNotice): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(notice)}\n`, { mode: 0o600 });
  };
  return {
    notice: readNotice,
    retire: async (instances) => {
      const existing = await readNotice();
      if (existing !== undefined) return existing;
      if (input.broker === undefined) return undefined;
      let deletedCount = 0;
      for (const instance of instances) {
        if (instance.driverKind !== "claude") continue;
        try {
          if (!(await input.broker.has(String(instance.id)))) continue;
          const raw = await input.broker.resolve(String(instance.id));
          if (!isHelperEnvelope(raw)) continue;
          await input.broker.delete(String(instance.id));
          deletedCount += 1;
        } catch {
          return undefined;
        }
      }
      if (deletedCount === 0) {
        await writeNotice({ deletedCount: 0, acknowledged: true });
        return { deletedCount: 0, acknowledged: true };
      }
      const notice = { deletedCount, acknowledged: false };
      await writeNotice(notice);
      return notice;
    },
    acknowledge: async () => {
      const existing = await readNotice();
      await writeNotice({
        deletedCount: existing?.deletedCount ?? 0,
        acknowledged: true,
      });
    },
  };
}

export const CLAUDE_HELPER_TOKEN_RETIRED_MESSAGE =
  "Octant no longer stores a Claude helper token. If you previously connected Claude for helpers, revoke that leftover token with Anthropic.";
