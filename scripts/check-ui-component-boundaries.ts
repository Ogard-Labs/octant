import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const WEB_SOURCE = "apps/web/src";
const SOURCE_EXTENSION = /\.(?:ts|tsx)$/;
const BASE_UI_IMPORT = /from\s+["']@base-ui\/react(?:\/[^"']+)?["']/;
const SHADCN_IMPORT = /from\s+["'][^"']*ui\/shadcn(?:\/[^"']+)?["']/;

export function findUiComponentBoundaryViolations(
  files: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  const violations: string[] = [];
  for (const [file, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const normalized = file.split(sep).join("/");
    if (BASE_UI_IMPORT.test(source) && !normalized.startsWith(`${WEB_SOURCE}/ui/`)) {
      violations.push(`${normalized} imports @base-ui/react outside apps/web/src/ui.`);
    }
    if (SHADCN_IMPORT.test(source) && !normalized.startsWith(`${WEB_SOURCE}/ui/base/`)) {
      violations.push(`${normalized} imports ui/shadcn outside apps/web/src/ui/base.`);
    }
  }
  return violations;
}

async function sourceFiles(root: string): Promise<Readonly<Record<string, string>>> {
  const files: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name)) {
        files[relative(root, absolute).split(sep).join("/")] = await readFile(absolute, "utf8");
      }
    }
  };
  await visit(resolve(root, WEB_SOURCE));
  return files;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const violations = findUiComponentBoundaryViolations(await sourceFiles(root));
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exitCode = 1;
    return;
  }
  console.log("UI component boundaries are valid.");
}

if (import.meta.main) await main();
