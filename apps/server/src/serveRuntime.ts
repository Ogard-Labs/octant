import type { Serve } from "./server";

type RuntimeKind = "bun" | "node";

interface LoadRuntimeServeOptions {
  readonly versions?: Readonly<Record<string, string | undefined>>;
  readonly loadBun?: () => Promise<Serve>;
  readonly loadNode?: () => Promise<Serve>;
}

export function runtimeServeKind(
  versions: Readonly<Record<string, string | undefined>> = process.versions,
): RuntimeKind {
  return versions.bun === undefined ? "node" : "bun";
}

export async function loadRuntimeServe(options: LoadRuntimeServeOptions = {}): Promise<Serve> {
  const kind = runtimeServeKind(options.versions);
  if (kind === "bun") {
    return await (options.loadBun ?? (async () => (await import("./bunServe")).bunServe))();
  }
  return await (options.loadNode ?? (async () => (await import("./nodeServe")).nodeServe))();
}
