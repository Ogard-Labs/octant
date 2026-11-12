/**
 * Probes every connector in the bundled catalog the way its entry promises it
 * behaves, so an address that changed or stopped answering is found before a
 * person clicks Connect. The catalog's own comment states the rule: a sign-in
 * server answers a bare request with 401 and resource metadata, and its
 * authorization server publishes PKCE S256 and, unless the entry needs a
 * registered client, dynamic client registration; a key server answers 401; an
 * open server answers without a credential. Each entry's vendor docs page must
 * load too. The Google preview servers answer `initialize` without a credential
 * and ask for one at the tool call (seen 2026-11-07), so a sign-in server that
 * answers 200 passes when its well-known resource metadata holds up, with a note.
 *
 * This reaches the network, so it runs on demand (`bun run connectors:probe`)
 * and on a weekly schedule in CI, never in `verify` or the app.
 */
import {
  connectorCatalog,
  type ConnectorCatalogEntry,
} from "../packages/domain/src/connectorCatalog";

export type ProbeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type ProbeResult =
  | { readonly status: "ok"; readonly id: string; readonly note?: string }
  | { readonly status: "refused"; readonly id: string; readonly reason: string };

const TIMEOUT_MS = 15_000;
// Some docs sites refuse a client that does not look like a browser.
const BROWSER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "octant-catalog-probe", version: "0" },
  },
});

function bareInitialize(fetcher: ProbeFetch, url: string): Promise<Response> {
  return fetcher(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: INITIALIZE,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** A 2xx counts as an MCP answer only when it is JSON or an event stream, not an HTML page. */
function answersMcp(response: Response): boolean {
  const type = response.headers.get("content-type") ?? "";
  return response.ok && (type.includes("application/json") || type.includes("text/event-stream"));
}

/** A bot wall or rate limit says nothing about the server behind it. */
function walled(entry: ConnectorCatalogEntry, response: Response): ProbeResult | undefined {
  return response.status === 403 || response.status === 429
    ? {
        status: "ok",
        id: entry.id,
        note: `server answered ${response.status} to the probe; not checked`,
      }
    : undefined;
}

function unexpected(
  entry: ConnectorCatalogEntry,
  response: Response,
  expected: string,
): ProbeResult {
  const location = response.headers.get("location");
  return {
    status: "refused",
    id: entry.id,
    reason:
      response.status >= 300 && response.status < 400
        ? `redirected (${response.status})${location === null ? "" : ` to ${location}`}; the catalog address should be the final one`
        : `answered ${response.status}${answersMcp(response) || !response.ok ? "" : " with no MCP answer"}, ${expected}`,
  };
}

async function readJson(
  fetcher: ProbeFetch,
  url: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The protected-resource metadata URL a 401 names, or the well-known default for the address. */
function resourceMetadataUrl(url: string, challenge: string): string {
  const named = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  if (named !== undefined) return new URL(named, url).href;
  const address = new URL(url);
  const path = address.pathname === "/" ? "" : address.pathname;
  return `${address.origin}/.well-known/oauth-protected-resource${path}`;
}

/** RFC 8414 path-inserted metadata first, then the appended and OpenID forms some issuers use. */
function authorizationMetadataUrls(issuer: string): ReadonlyArray<string> {
  const address = new URL(issuer);
  const path = address.pathname.replace(/\/$/, "");
  const base = issuer.replace(/\/$/, "");
  return [
    `${address.origin}/.well-known/oauth-authorization-server${path}`,
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];
}

async function probeSignIn(
  entry: ConnectorCatalogEntry,
  fetcher: ProbeFetch,
  registered: boolean,
): Promise<ProbeResult> {
  const response = await bareInitialize(fetcher, entry.url);
  const challenged = response.status === 401;
  if (!challenged && !answersMcp(response))
    return walled(entry, response) ?? unexpected(entry, response, "expected 401");
  const metadata = await readJson(
    fetcher,
    resourceMetadataUrl(entry.url, response.headers.get("www-authenticate") ?? ""),
  );
  const servers = metadata?.["authorization_servers"];
  const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : undefined;
  if (issuer === undefined)
    return {
      status: "refused",
      id: entry.id,
      reason: "no resource metadata naming an authorization server",
    };
  for (const candidate of authorizationMetadataUrls(issuer)) {
    const server = await readJson(fetcher, candidate);
    if (server === undefined) continue;
    const methods = server["code_challenge_methods_supported"];
    if (!Array.isArray(methods) || !methods.includes("S256"))
      return { status: "refused", id: entry.id, reason: `${issuer} does not publish PKCE S256` };
    if (!registered && typeof server["registration_endpoint"] !== "string")
      return {
        status: "refused",
        id: entry.id,
        reason: `${issuer} publishes no dynamic client registration`,
      };
    return challenged
      ? { status: "ok", id: entry.id }
      : { status: "ok", id: entry.id, note: "answers initialize without a credential" };
  }
  return {
    status: "refused",
    id: entry.id,
    reason: `${issuer} publishes no authorization metadata`,
  };
}

async function probeServer(
  entry: ConnectorCatalogEntry,
  fetcher: ProbeFetch,
): Promise<ProbeResult> {
  switch (entry.auth.kind) {
    case "sign-in":
      return probeSignIn(entry, fetcher, entry.auth.clientSetup === "registered");
    case "key": {
      const response = await bareInitialize(fetcher, entry.url);
      return response.status === 401
        ? { status: "ok", id: entry.id }
        : (walled(entry, response) ?? unexpected(entry, response, "expected 401 without a key"));
    }
    case "command": {
      // No address to probe: the pin must still exist on the registry with the
      // integrity the catalog holds. A newer latest is a note, not a failure.
      const { name, version, integrity } = entry.auth.package;
      const response = await fetcher(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return unexpected(entry, response, "registry did not answer");
      const document = (await response.json()) as {
        "dist-tags"?: { latest?: string };
        versions?: Record<string, { dist?: { integrity?: string } }>;
      };
      if (document.versions?.[version]?.dist?.integrity !== integrity) {
        return {
          status: "refused",
          id: entry.id,
          reason: `${name}@${version} is not on the registry with the pinned integrity`,
        };
      }
      const latest = document["dist-tags"]?.latest;
      return latest === version
        ? { status: "ok", id: entry.id }
        : { status: "ok", id: entry.id, note: `newer version ${latest ?? "unknown"} is published` };
    }
    case "none": {
      const response = await bareInitialize(fetcher, entry.url);
      return answersMcp(response)
        ? { status: "ok", id: entry.id }
        : (walled(entry, response) ??
            unexpected(entry, response, "expected an MCP answer without a credential"));
    }
  }
}

async function probeDocs(entry: ConnectorCatalogEntry, fetcher: ProbeFetch): Promise<ProbeResult> {
  const response = await fetcher(entry.docs, {
    headers: { "user-agent": BROWSER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.ok) return { status: "ok", id: entry.id };
  // A bot wall says nothing about whether the page exists; report it without failing.
  if (response.status === 403 || response.status === 429)
    return { status: "ok", id: entry.id, note: `docs answered ${response.status} to the probe` };
  return { status: "refused", id: entry.id, reason: `docs page answered ${response.status}` };
}

/** Checks one entry's server, then its docs page; a network failure is a refusal with its message. */
export async function probeConnector(
  entry: ConnectorCatalogEntry,
  fetcher: ProbeFetch = fetch,
): Promise<ProbeResult> {
  try {
    const server = await probeServer(entry, fetcher);
    if (server.status === "refused") return server;
    const docs = await probeDocs(entry, fetcher);
    if (docs.status === "refused" || server.note === undefined) return docs;
    const notes = [server.note, ...(docs.note === undefined ? [] : [docs.note])];
    return { status: "ok", id: entry.id, note: notes.join("; ") };
  } catch (error) {
    return {
      status: "refused",
      id: entry.id,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

if (import.meta.main) {
  const results = await Promise.all(connectorCatalog().map((entry) => probeConnector(entry)));
  const refused = results.filter((result) => result.status === "refused");
  for (const result of results) {
    if (result.status === "refused") console.log(`refused  ${result.id}: ${result.reason}`);
    else
      console.log(`ok       ${result.id}${result.note === undefined ? "" : ` (${result.note})`}`);
  }
  console.log(
    `\n${results.length - refused.length} of ${results.length} connectors behave as listed.`,
  );
  if (refused.length > 0) process.exit(1);
}
