import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "vite";

// Count the static graph Vite loads for index.html. Dynamic imports, the
// separately built Canvas preview, and non-code assets are not initial code.
const root = resolve(import.meta.dirname, "../apps/web");
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
        console.log(
          JSON.stringify(
            {
              mainEntryBytes: Buffer.byteLength(entry.code),
              javascriptBytes,
              cssBytes,
              gzipBytes,
              chunks: visited.size,
              sourcesByRenderedBytes: [...initialSources].sort(([, a], [, b]) => b - a),
            },
            null,
            2,
          ),
        );
      },
    },
  ],
});
