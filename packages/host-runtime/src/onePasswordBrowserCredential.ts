import type { CommandRunner } from "./linkedSecretStores";
import {
  readOnePasswordBrowserMetadata,
  type BrowserItemMetadata,
} from "./onePasswordBrowserMetadata";

export interface BrowserCredentialValues {
  readonly username: string;
  readonly password: string;
}
export type BrowserCredentialConsumption =
  | { readonly status: "consumed" }
  | {
      readonly status:
        | "changed"
        | "invalid-item"
        | "locked"
        | "missing"
        | "unavailable"
        | "uncertain"
        | "not-linked"
        | "cancelled";
    };

/** The consumer runs inside host custody. Neither result nor diagnostics contain fields. */
export async function consumeOnePasswordBrowserCredential(
  expected:
    | Extract<BrowserItemMetadata, { readonly status: "described" }>
    | Omit<Extract<BrowserItemMetadata, { readonly status: "described" }>, "status">,
  options: {
    readonly executable: string;
    readonly run: CommandRunner;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
  },
  consume: (values: BrowserCredentialValues) => Promise<void>,
): Promise<BrowserCredentialConsumption> {
  let selected: string | undefined;
  const metadata = await readOnePasswordBrowserMetadata(expected.item, {
    ...options,
    run: async (...args) => {
      const outcome = await options.run(...args);
      if (outcome.kind === "exited" && outcome.exitCode === 0) selected = outcome.stdout;
      return outcome;
    },
  });
  if (metadata.status !== "described") return metadata;
  if (
    metadata.version !== expected.version ||
    metadata.title !== expected.title ||
    JSON.stringify(metadata.websiteOrigins) !== JSON.stringify(expected.websiteOrigins)
  )
    return { status: "changed" };
  if (selected === undefined) return { status: "uncertain" };
  try {
    const value: unknown = JSON.parse(selected);
    selected = undefined;
    if (!record(value) || value.category !== "LOGIN" || !Array.isArray(value.fields))
      return { status: "uncertain" };
    const usernames = value.fields.filter(
      (field) => record(field) && (field.purpose === "USERNAME" || field.id === "username"),
    );
    const passwords = value.fields.filter(
      (field) => record(field) && (field.purpose === "PASSWORD" || field.id === "password"),
    );
    const username = usernames[0];
    const password = passwords[0];
    if (
      usernames.length !== 1 ||
      passwords.length !== 1 ||
      !record(username) ||
      !record(password) ||
      username.id !== "username" ||
      username.purpose !== "USERNAME" ||
      username.type !== "STRING" ||
      password.id !== "password" ||
      password.purpose !== "PASSWORD" ||
      password.type !== "CONCEALED" ||
      typeof username.value !== "string" ||
      typeof password.value !== "string" ||
      username.value.length === 0 ||
      password.value.length === 0 ||
      Buffer.byteLength(username.value, "utf8") > 4096 ||
      Buffer.byteLength(password.value, "utf8") > 12 * 1024
    )
      return { status: "uncertain" };
    await consume({ username: username.value, password: password.value });
    return { status: "consumed" };
  } catch {
    return { status: "unavailable" };
  } finally {
    selected = undefined;
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
