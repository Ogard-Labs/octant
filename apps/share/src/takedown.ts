import { digestsMatch, hashOwnerSecret, isShareId, type ShareStore } from "./store.ts";

export type TakedownOutcome =
  | { readonly status: "taken-down" }
  | { readonly status: "already-gone" }
  | { readonly status: "not-found" }
  | { readonly status: "invalid-id" };

const TAKEDOWN_PREFIX = "/operator/v1/takedown/";

/**
 * Deletes the payload and leaves a "taken-down" tombstone so the link answers
 * 410 "removed". It runs in the serving process on that process's store, so
 * no view or update can write the payload back after the tombstone, and the
 * store's byte total drops with it.
 */
export function takeDown(store: ShareStore, id: string): TakedownOutcome {
  if (!isShareId(id)) return { status: "invalid-id" };
  const lookup = store.lookup(id);
  if (lookup.status === "missing") return { status: "not-found" };
  if (lookup.status === "gone") return { status: "already-gone" };
  store.remove(id, "taken-down");
  return { status: "taken-down" };
}

/**
 * The operator listener's one route. The listener is bound to 127.0.0.1, and
 * the token is compared by digest in constant time; anything else is 404.
 */
export function handleOperator(request: Request, store: ShareStore, token: string): Response {
  const url = new URL(request.url);
  if (request.method !== "POST" || !url.pathname.startsWith(TAKEDOWN_PREFIX)) {
    return Response.json({ status: "not-found" }, { status: 404 });
  }
  const presented = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!digestsMatch(hashOwnerSecret(presented), hashOwnerSecret(token))) {
    return Response.json({ status: "unauthorized" }, { status: 403 });
  }
  const outcome = takeDown(store, url.pathname.slice(TAKEDOWN_PREFIX.length));
  const status = { "taken-down": 200, "already-gone": 200, "not-found": 404, "invalid-id": 400 }[
    outcome.status
  ];
  return Response.json(outcome, { status, headers: { "cache-control": "no-store" } });
}

export async function runTakedown(
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ readonly code: number; readonly message: string }> {
  const id = args.find((argument) => argument !== "");
  const token = env["OCTANT_SHARE_OPERATOR_TOKEN"];
  const port = env["OCTANT_SHARE_OPERATOR_PORT"] ?? "4102";
  if (id === undefined || token === undefined || token === "" || !/^\d+$/.test(port)) {
    return {
      code: 2,
      message:
        "Usage: bun run takedown <id>, with OCTANT_SHARE_OPERATOR_TOKEN (and OCTANT_SHARE_OPERATOR_PORT if not 4102) as the running service has them.",
    };
  }
  if (!isShareId(id))
    return { code: 2, message: "That is not a link id (22 URL-safe characters)." };
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${TAKEDOWN_PREFIX}${id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return {
      code: 1,
      message: `The share service is not answering on 127.0.0.1:${port}. Takedown needs it running.`,
    };
  }
  if (response.status === 403) {
    return { code: 1, message: "The service refused the operator token." };
  }
  const body: unknown = await response.json().catch(() => undefined);
  const status = typeof body === "object" && body !== null && "status" in body ? body.status : "";
  switch (status) {
    case "taken-down":
      return { code: 0, message: `Taken down ${id}. The link now answers 410 "removed".` };
    case "already-gone":
      return { code: 0, message: `${id} was already gone; nothing changed.` };
    case "not-found":
      return { code: 1, message: `The service holds no link ${id}.` };
    default:
      return { code: 1, message: `The service could not take down ${id}.` };
  }
}

if (import.meta.main) {
  const result = await runTakedown(process.argv.slice(2), process.env);
  (result.code === 0 ? console.log : console.error)(result.message);
  process.exit(result.code);
}
