import { isShareId, ShareStore } from "./store.ts";

export type TakedownOutcome =
  | { readonly status: "taken-down" }
  | { readonly status: "already-gone" }
  | { readonly status: "not-found" }
  | { readonly status: "invalid-id" };

/** Deletes the payload and leaves a "taken-down" tombstone so the link answers 410 "removed". */
export function takeDown(dataDir: string, id: string): TakedownOutcome {
  if (!isShareId(id)) return { status: "invalid-id" };
  const store = new ShareStore(dataDir, { maxTotalBytes: Number.MAX_SAFE_INTEGER });
  const lookup = store.lookup(id);
  if (lookup.status === "missing") return { status: "not-found" };
  if (lookup.status === "gone") return { status: "already-gone" };
  store.remove(id, "taken-down");
  return { status: "taken-down" };
}

export function runTakedown(
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): { readonly code: number; readonly message: string } {
  let dataDir = env["OCTANT_SHARE_DATA_DIR"];
  let id: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--data-dir") {
      dataDir = args[index + 1];
      index += 1;
    } else if (argument !== undefined) {
      id = argument;
    }
  }
  if (id === undefined || dataDir === undefined || dataDir === "") {
    return {
      code: 2,
      message: "Usage: bun run takedown <id> [--data-dir <dir>] (default OCTANT_SHARE_DATA_DIR)",
    };
  }
  const outcome = takeDown(dataDir, id);
  switch (outcome.status) {
    case "taken-down":
      return { code: 0, message: `Taken down ${id}. The link now answers 410 "removed".` };
    case "already-gone":
      return { code: 0, message: `${id} was already gone; nothing changed.` };
    case "not-found":
      return { code: 1, message: `No link ${id} in ${dataDir}.` };
    case "invalid-id":
      return { code: 2, message: "That is not a link id (22 URL-safe characters)." };
  }
}

if (import.meta.main) {
  const result = runTakedown(process.argv.slice(2), process.env);
  (result.code === 0 ? console.log : console.error)(result.message);
  process.exit(result.code);
}
