import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Names the exact server build that is running, or nothing when it is not a
 * bundled build. The startup watermark trusts rows verified by an earlier start
 * only if this start would decode them identically.
 *
 * The server ships as one bundle with every `@octant/*` package inlined, split
 * into chunks beside the running module (the journal's schemas live in chunks
 * other than the one that runs this code). `effect` is the only external
 * dependency that defines or runs those schemas (the other externals open
 * files, run processes or parse skill metadata). So the identity is the bytes
 * of every chunk in the bundle folder plus the `effect` version resolved beside
 * it. A source run (bun, tsx, vitest) has no identity.
 */
export type BuildIdentity = () => string | undefined;

function effectVersion(moduleUrl: string): string | undefined {
  try {
    const entry = createRequire(moduleUrl).resolve("effect");
    let directory = dirname(entry);
    for (;;) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
          readonly name?: unknown;
          readonly version?: unknown;
        };
        if (parsed.name === "effect") {
          return typeof parsed.version === "string" ? parsed.version : undefined;
        }
      }
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  } catch {
    return undefined;
  }
}

/** Computes lazily and at most once; the caller asks only when it uses the watermark. */
export function bundledBuildIdentity(moduleUrl: string): BuildIdentity {
  let computed: { readonly value: string | undefined } | undefined;
  return () => {
    if (computed !== undefined) return computed.value;
    let value: string | undefined;
    try {
      if (/\.m?js$/.test(moduleUrl)) {
        const version = effectVersion(moduleUrl);
        if (version !== undefined) {
          const directory = dirname(fileURLToPath(moduleUrl));
          const hash = createHash("sha256");
          for (const name of readdirSync(directory)
            .filter((file) => /\.m?js$/.test(file))
            .sort()) {
            hash.update(`${name}\n`).update(readFileSync(join(directory, name)));
          }
          value = `${hash.digest("hex")}+effect@${version}`;
        }
      }
    } catch {
      value = undefined;
    }
    computed = { value };
    return value;
  };
}
