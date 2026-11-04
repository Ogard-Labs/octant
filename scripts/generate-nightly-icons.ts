import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Reproduce native icon pixels without changing the canonical Stable assets. */
export async function generateNightlyIcons(
  repositoryRoot: string,
  mode: "write" | "check",
): Promise<ReadonlyArray<string>> {
  if (process.platform !== "darwin") throw new Error("Nightly icon generation requires macOS.");
  const temporary = await mkdtemp(join(tmpdir(), "octant-nightly-icons-"));
  const binary = join(temporary, "generate-icons");
  const run = (executable: string, args: ReadonlyArray<string>) =>
    execFileSync(executable, [...args], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1_048_576,
    });
  const reports: string[] = [];
  try {
    run("/usr/bin/xcrun", [
      "swiftc",
      "-O",
      "-target",
      `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`,
      join(repositoryRoot, "scripts/generate-nightly-icons.swift"),
      "-o",
      binary,
    ]);
    reports.push(run(binary, ["self-test"]).trim());
    for (const extension of ["png", "icns"]) {
      const original = join(repositoryRoot, `apps/desktop/resources/icon.${extension}`);
      const destination = join(repositoryRoot, `apps/desktop/resources/icon-nightly.${extension}`);
      const before = createHash("sha256")
        .update(await readFile(original))
        .digest("hex");
      const generated = join(temporary, `icon-nightly.${extension}`);
      run(binary, ["generate", original, generated]);
      reports.push(run(binary, ["verify", original, generated]).trim());
      if (mode === "check") reports.push(run(binary, ["verify", original, destination]).trim());
      const after = createHash("sha256")
        .update(await readFile(original))
        .digest("hex");
      if (before !== after) throw new Error("The canonical Stable icon changed during generation.");
      if (mode === "write") await copyFile(generated, destination);
    }
    return reports;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  if ((mode !== "--write" && mode !== "--check") || process.argv.length !== 3)
    throw new Error("Use --write to regenerate Nightly icons or --check to verify them.");
  for (const report of await generateNightlyIcons(root, mode === "--write" ? "write" : "check"))
    console.log(report);
}
