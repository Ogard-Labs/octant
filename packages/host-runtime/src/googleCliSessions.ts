import { constants, createPrivateKey, sign } from "node:crypto";
import {
  googleCliPointerOf,
  type GoogleCliPointer,
  type LinkedSecretRead,
  type LinkedSecretStores,
} from "./linkedSecretStores";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const MAX_RESPONSE_BYTES = 64 * 1024;
export type GoogleCliSessionResult =
  | {
      readonly status: "issued";
      readonly accessToken: string;
      readonly expiration: string;
      readonly serviceAccountEmail: string;
      readonly scopes: ReadonlyArray<string>;
    }
  | { readonly status: "none" | "refused" }
  | Exclude<LinkedSecretRead, { readonly status: "read" }>;
type GoogleCliConfigureResult =
  | { readonly status: "pointed" | "superseded" | "refused" }
  | Exclude<LinkedSecretRead, { readonly status: "read" }>;
type GoogleCliClearResult =
  | { readonly status: "none" }
  | ({ readonly status: "cleared" } & GoogleCliPointer);
export interface GoogleCliSessions {
  readonly session: () => Promise<GoogleCliSessionResult>;
  readonly forget: () => void;
  readonly configure: (
    pointer: GoogleCliPointer,
    restoring: boolean,
  ) => Promise<GoogleCliConfigureResult>;
  readonly clear: () => Promise<GoogleCliClearResult>;
}

export function createGoogleCliSessions(options: {
  readonly linked: LinkedSecretStores;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}): GoogleCliSessions {
  const now = options.now ?? Date.now;
  const fetchPort = options.fetch ?? globalThis.fetch;
  let generation = 0;
  let selection = 0;
  let commits: Promise<unknown> = Promise.resolve();
  const commit = <T>(write: () => Promise<T>): Promise<T> => {
    const pending = commits.then(write);
    commits = pending.catch(() => undefined);
    return pending;
  };
  let held:
    | {
        readonly key: string;
        readonly value: Extract<GoogleCliSessionResult, { status: "issued" }>;
      }
    | undefined;
  const issue = async (
    pointer: GoogleCliPointer,
    started: number,
  ): Promise<GoogleCliSessionResult> => {
    const item = await deadline(
      options.linked.read(pointer.store, pointer.reference),
      options.timeoutMs ?? 10000,
    );
    if (started !== generation) return { status: "none" };
    if (item === undefined) return { status: "unavailable" };
    if (item.status !== "read") return item;
    const assertion = serviceAccountAssertion(item.value, pointer, now());
    if (assertion === undefined) return { status: "refused" };
    const issuedAt = now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<GoogleCliSessionResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: "unavailable" });
      }, options.timeoutMs ?? 10000);
    });
    const exchange = async (): Promise<GoogleCliSessionResult> => {
      try {
        const response = await fetchPort(TOKEN_ENDPOINT, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }).toString(),
        });
        if (!response.ok || response.body === null) return { status: "refused" };
        const reader = response.body.getReader();
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            bytes += result.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES || controller.signal.aborted) {
              await reader.cancel().catch(() => undefined);
              return { status: "refused" };
            }
            chunks.push(result.value);
          }
        } finally {
          reader.releaseLock();
        }
        if (controller.signal.aborted) return { status: "unavailable" };
        const parsed: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        );
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
          return { status: "refused" };
        const token = parsed as Record<string, unknown>;
        if (
          typeof token.access_token !== "string" ||
          token.access_token.length < 1 ||
          token.access_token.length > 16384 ||
          !/^[A-Za-z0-9._~+/-]+=*$/.test(token.access_token) ||
          token.token_type !== "Bearer" ||
          typeof token.expires_in !== "number" ||
          !Number.isSafeInteger(token.expires_in) ||
          token.expires_in < 60 ||
          token.expires_in > 3600 ||
          issuedAt + token.expires_in * 1000 <= now() + 30000 ||
          (token.scope !== undefined &&
            (typeof token.scope !== "string" ||
              token.scope.split(/\s+/).filter(Boolean).sort().join(" ") !==
                [...pointer.scopes].sort().join(" ")))
        )
          return { status: "refused" };
        return {
          status: "issued",
          accessToken: token.access_token,
          expiration: new Date(issuedAt + token.expires_in * 1000).toISOString(),
          serviceAccountEmail: pointer.serviceAccountEmail,
          scopes: pointer.scopes,
        };
      } catch {
        return { status: "unavailable" };
      }
    };
    try {
      return await Promise.race([exchange(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  const forget = () => {
    generation += 1;
    held = undefined;
  };
  return {
    configure: async (pointer, restoring) => {
      const version = ++selection;
      forget();
      if (options.linked.setGoogleCliPointer === undefined) return { status: "unavailable" };
      if (!restoring) {
        const item = await deadline(
          options.linked.read(pointer.store, pointer.reference),
          options.timeoutMs ?? 10000,
        );
        if (version !== selection) return { status: "superseded" };
        if (item === undefined) return { status: "unavailable" };
        if (item.status !== "read") return { status: item.status };
        if (serviceAccountAssertion(item.value, pointer, now()) === undefined)
          return { status: "refused" };
      } else if (!options.linked.isValidReference(pointer.store, pointer.reference))
        return { status: "invalid-reference" };
      const linked = await options.linked.isLinked(pointer.store);
      if (version !== selection) return { status: "superseded" };
      if (!linked) return { status: "not-linked" };
      return commit<GoogleCliConfigureResult>(async () => {
        if (version !== selection) return { status: "superseded" };
        await options.linked.setGoogleCliPointer?.(pointer);
        return { status: version === selection ? "pointed" : "superseded" };
      });
    },
    clear: async () => {
      selection += 1;
      forget();
      return commit<GoogleCliClearResult>(async () => {
        const pointer = await options.linked.googleCliPointer?.();
        await options.linked.setGoogleCliPointer?.(undefined);
        return pointer === undefined ? { status: "none" } : { status: "cleared", ...pointer };
      });
    },
    forget: () => {
      generation += 1;
      held = undefined;
    },
    session: async () => {
      const pointer = await options.linked.googleCliPointer?.();
      if (pointer === undefined) return { status: "none" };
      if (!(await options.linked.isLinked(pointer.store))) return { status: "not-linked" };
      const key = JSON.stringify(pointer);
      if (held?.key === key && Date.parse(held.value.expiration) - now() > 60000) return held.value;
      const started = generation;
      const value = await issue(pointer, started);
      const current = await options.linked.googleCliPointer?.();
      const linked = await options.linked.isLinked(pointer.store);
      if (started !== generation || JSON.stringify(current) !== key || !linked)
        return { status: "none" };
      if (value.status === "issued") held = { key, value };
      return value;
    },
  };
}

function serviceAccountAssertion(
  material: string,
  pointer: GoogleCliPointer,
  time: number,
): string | undefined {
  try {
    const parsed: unknown = JSON.parse(material);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const account = parsed as Record<string, unknown>;
    if (
      account.type !== "service_account" ||
      account.client_email !== pointer.serviceAccountEmail ||
      typeof account.private_key !== "string"
    )
      return undefined;
    const key = createPrivateKey(account.private_key);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      return undefined;
    const kid =
      typeof account.private_key_id === "string" &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(account.private_key_id)
        ? account.private_key_id
        : undefined;
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT", ...(kid === undefined ? {} : { kid }) }),
    ).toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({
        iss: pointer.serviceAccountEmail,
        scope: pointer.scopes.join(" "),
        aud: TOKEN_ENDPOINT,
        iat: Math.floor(time / 1000),
        exp: Math.floor(time / 1000) + 3600,
      }),
    ).toString("base64url");
    const input = `${header}.${claims}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), { key, padding: constants.RSA_PKCS1_PADDING }).toString("base64url")}`;
  } catch {
    return undefined;
  }
}

export async function handleGoogleCliBrokerRoute(
  operation: string,
  body: Readonly<Record<string, unknown>>,
  linked: LinkedSecretStores,
  sessions: GoogleCliSessions,
): Promise<Response> {
  if (operation === "session" || operation === "reference" || operation === "clear") {
    if (Object.keys(body).length !== 0)
      return Response.json({ error: "invalid-request" }, { status: 400 });
    if (operation === "session") return Response.json(await sessions.session());
    if (operation === "clear") return Response.json(await sessions.clear());
    const pointer = await linked.googleCliPointer?.();
    return Response.json(
      pointer === undefined ? { status: "none" } : { status: "linked", ...pointer },
    );
  }
  if (operation !== "point" && operation !== "restore")
    return Response.json({ error: "invalid-request" }, { status: 400 });
  const pointer = googleCliPointerOf(body);
  if (pointer === undefined) return Response.json({ error: "invalid-request" }, { status: 400 });
  return Response.json(await sessions.configure(pointer, operation === "restore"));
}

async function deadline<T>(pending: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
