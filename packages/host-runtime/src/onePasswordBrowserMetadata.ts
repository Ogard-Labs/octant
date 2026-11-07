import type { CommandRunner } from "./linkedSecretStores";

export interface BrowserCredentialItemPin {
  readonly store: "onepassword";
  readonly accountId: string;
  readonly vaultId: string;
  readonly itemId: string;
}

export type BrowserItemMetadata =
  | {
      readonly status: "described";
      readonly item: BrowserCredentialItemPin;
      readonly title: string;
      readonly version: number;
      readonly websiteOrigins: ReadonlyArray<string>;
    }
  | {
      readonly status: "invalid-item" | "locked" | "missing" | "unavailable" | "uncertain";
    };

export async function readOnePasswordBrowserMetadata(
  item: BrowserCredentialItemPin,
  options: {
    readonly executable: string;
    readonly run: CommandRunner;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
  },
): Promise<BrowserItemMetadata> {
  if (![item.accountId, item.vaultId, item.itemId].every((id) => /^[a-z0-9]{26}$/i.test(id)))
    return { status: "invalid-item" };
  // Connect and service-account authority do not identify the selected
  // person's account. They cannot silently replace this explicit selection.
  if (
    options.env.OP_SERVICE_ACCOUNT_TOKEN !== undefined ||
    options.env.OP_CONNECT_HOST !== undefined ||
    options.env.OP_CONNECT_TOKEN !== undefined
  )
    return { status: "unavailable" };
  try {
    const result = await options.run(
      options.executable,
      [
        "item",
        "get",
        item.itemId,
        "--account",
        item.accountId,
        "--vault",
        item.vaultId,
        "--format",
        "json",
      ],
      {
        timeoutMs: options.timeoutMs,
        env: Object.fromEntries(
          Object.entries(options.env).filter(
            ([name]) =>
              name !== "OP_ACCOUNT" && name !== "OP_INCLUDE_ARCHIVE" && !name.startsWith("OCTANT_"),
          ),
        ),
      },
    );
    if (result.kind !== "exited") return { status: "unavailable" };
    if (result.exitCode !== 0) {
      if (/could not be found|does not exist|isn't an item|isn't a vault/i.test(result.stderr))
        return { status: "missing" };
      if (/not signed in|signed out|locked|unlock|authenticat/i.test(result.stderr))
        return { status: "locked" };
      return { status: "unavailable" };
    }
    if (Buffer.byteLength(result.stdout, "utf8") > 32 * 1024) return { status: "uncertain" };
    const value: unknown = JSON.parse(result.stdout);
    if (
      !record(value) ||
      value.id !== item.itemId ||
      !record(value.vault) ||
      value.vault.id !== item.vaultId ||
      typeof value.title !== "string" ||
      value.title.trim().length === 0 ||
      value.title.length > 256 ||
      [...value.title].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      typeof value.version !== "number" ||
      !Number.isSafeInteger(value.version) ||
      value.version < 1 ||
      !Array.isArray(value.urls) ||
      value.urls.length < 1 ||
      value.urls.length > 8
    )
      return { status: "uncertain" };
    const origins: string[] = [];
    for (const website of value.urls) {
      if (!record(website) || typeof website.href !== "string" || website.href.length > 2048)
        return { status: "uncertain" };
      const url = new URL(website.href);
      if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
        return { status: "uncertain" };
      origins.push(url.origin);
    }
    // Item JSON may contain concealed field values. Only these named metadata
    // fields cross the adapter boundary; raw JSON and diagnostics are discarded.
    return {
      status: "described",
      item: {
        store: "onepassword",
        accountId: item.accountId,
        vaultId: item.vaultId,
        itemId: item.itemId,
      },
      title: value.title.trim(),
      version: value.version,
      websiteOrigins: [...new Set(origins)],
    };
  } catch {
    return { status: "uncertain" };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
