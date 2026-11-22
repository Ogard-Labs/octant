import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "vite";

/**
 * The initial renderer budget lives in `scripts/initial-renderer-budget.json`.
 * `--check` fails when a change grows the main entry, the initial CSS or the
 * initial gzip graph past it. The sizes are exact bytes with no headroom: the
 * same source measured identically on an Apple M5 Max and a Linux runner with
 * Bun 1.4.4. A change that shrinks the graph should lower the recorded budget.
 */
export const BUDGET_PATH = "scripts/initial-renderer-budget.json";

export interface InitialRendererSizes {
  readonly mainEntryBytes: number;
  readonly cssBytes: number;
  readonly gzipBytes: number;
}

export interface BudgetOverrun {
  readonly measure: keyof InitialRendererSizes;
  readonly measured: number;
  readonly budget: number;
}

const MEASURES: ReadonlyArray<keyof InitialRendererSizes> = [
  "mainEntryBytes",
  "cssBytes",
  "gzipBytes",
];

export function compareWithBudget(
  measured: InitialRendererSizes,
  budget: InitialRendererSizes,
): ReadonlyArray<BudgetOverrun> {
  return MEASURES.filter((measure) => measured[measure] > budget[measure]).map((measure) => ({
    measure,
    measured: measured[measure],
    budget: budget[measure],
  }));
}

// Count the static graph Vite loads for index.html. Dynamic imports, the
// separately built Canvas preview, and non-code assets are not initial code.
async function measure(root: string) {
  let report:
    | (InitialRendererSizes & {
        readonly javascriptBytes: number;
        readonly chunks: number;
        readonly sourcesByRenderedBytes: ReadonlyArray<readonly [string, number]>;
      })
    | undefined;
  await build({
    root,
    logLevel: "silent",
    build: { write: false },
    plugins: [
      {
        name: "octant-initial-renderer-measurement",
        generateBundle(_, bundle) {
          const entry = Object.values(bundle).find(
            (output) =>
              output.type === "chunk" &&
              output.isEntry &&
              output.facadeModuleId === resolve(root, "index.html"),
          );
          if (entry === undefined || entry.type !== "chunk") {
            throw new Error("Vite did not emit an index.html entry.");
          }
          const visited = new Set<string>();
          const cssFiles = new Set<string>();
          const initialSources = new Map<string, number>();
          let javascriptBytes = 0;
          let gzipBytes = 0;
          const visit = (file: string) => {
            if (visited.has(file)) return;
            const chunk = bundle[file];
            if (chunk?.type !== "chunk") throw new Error(`Missing initial chunk ${file}.`);
            visited.add(file);
            javascriptBytes += Buffer.byteLength(chunk.code);
            gzipBytes += gzipSync(chunk.code).byteLength;
            for (const css of chunk.viteMetadata?.importedCss ?? []) cssFiles.add(css);
            for (const dependency of chunk.imports) visit(dependency);
            for (const [id, module] of Object.entries(chunk.modules)) {
              if (module.renderedLength === 0) continue;
              const source = id.match(/\/apps\/web\/src\/([^/]+)/)?.[1];
              const workspace = id.match(/\/packages\/([^/]+)\/src\//)?.[1];
              const dependency = id.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/)?.[1];
              const group =
                source ?? (workspace === undefined ? dependency : `workspace/${workspace}`);
              if (group !== undefined) {
                initialSources.set(group, (initialSources.get(group) ?? 0) + module.renderedLength);
              }
            }
          };
          visit(entry.fileName);
          let cssBytes = 0;
          for (const file of cssFiles) {
            const asset = bundle[file];
            if (asset?.type !== "asset") throw new Error(`Missing initial stylesheet ${file}.`);
            cssBytes += Buffer.byteLength(asset.source);
            gzipBytes += gzipSync(asset.source).byteLength;
          }
          if (cssBytes === 0) throw new Error("The renderer entry did not report a stylesheet.");
          report = {
            mainEntryBytes: Buffer.byteLength(entry.code),
            javascriptBytes,
            cssBytes,
            gzipBytes,
            chunks: visited.size,
            sourcesByRenderedBytes: [...initialSources].sort(([, a], [, b]) => b - a),
          };
        },
      },
    ],
  });
  if (report === undefined) throw new Error("Vite finished without reporting the renderer graph.");
  return report;
}

async function main() {
  const repository = resolve(import.meta.dirname, "..");
  const report = await measure(resolve(repository, "apps/web"));
  if (!process.argv.includes("--check")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const budget = JSON.parse(
    await readFile(resolve(repository, BUDGET_PATH), "utf8"),
  ) as InitialRendererSizes;
  const overruns = compareWithBudget(report, budget);
  for (const measure of MEASURES) {
    console.log(`${measure}: ${String(report[measure])} B (budget ${String(budget[measure])} B)`);
  }
  if (overruns.length === 0) return;
  for (const overrun of overruns) {
    console.error(
      `${overrun.measure} grew to ${String(overrun.measured)} B, ${String(overrun.measured - overrun.budget)} B over its budget in ${BUDGET_PATH}. Load the new code or styles with the view that uses them; raising a budget needs a maintainer decision.`,
    );
  }
  process.exitCode = 1;
}

if (import.meta.main) await main();
