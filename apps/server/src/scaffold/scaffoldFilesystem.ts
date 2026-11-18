import { access, lstat, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, win32 } from "node:path";

/**
 * A directory name a scaffold may be asked about.
 *
 * The command schema already narrows this to one safe segment before the
 * service sees it. Checking again here is deliberate: this module joins the
 * name onto a checkout root, and a path helper that trusts its caller is how a
 * single missed decode becomes a write outside the checkout.
 */
function assertSingleSegment(name: string): void {
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === "." ||
    name === ".."
  ) {
    throw new Error("Scaffold directory name is not a single path segment.");
  }
}

/**
 * Whether anything already answers to this name in the checkout.
 *
 * `lstat`, not `stat`: a symlink is something, and a scaffold that wrote
 * through one would write wherever it points. Reporting the link itself is
 * what makes the refusal happen here rather than after the generator ran.
 */
export async function scaffoldEntryExists(input: {
  readonly checkoutRoot: string;
  readonly name: string;
}): Promise<boolean> {
  assertSingleSegment(input.name);
  try {
    await lstat(join(input.checkoutRoot, input.name));
    return true;
  } catch {
    return false;
  }
}

/** Make the new project directory, refusing rather than reusing an existing one. */
export async function makeScaffoldDirectory(input: {
  readonly checkoutRoot: string;
  readonly name: string;
}): Promise<void> {
  assertSingleSegment(input.name);
  await mkdir(join(input.checkoutRoot, input.name));
}

/**
 * Which of the named tools this machine can actually run.
 *
 * Resolved by looking along `PATH` rather than by running anything: asking a
 * generator whether it exists would already be the run the user has not
 * approved yet. On Windows a tool is found as Windows finds it, by name with
 * each `PATHEXT` extension (`bunx.exe`, `npx.cmd`), as the test and scaffold
 * runner then starts it; the bare name alone is never a program there.
 */
export async function resolveAvailableTools(
  tools: ReadonlyArray<string>,
  environmentPath: string | undefined = process.env["PATH"],
  host: { readonly platform: NodeJS.Platform; readonly pathExtensions?: string | undefined } = {
    platform: process.platform,
    pathExtensions: process.env["PATHEXT"],
  },
): Promise<ReadonlyArray<string>> {
  const onWindows = host.platform === "win32";
  const directories = (environmentPath ?? "")
    .split(onWindows ? win32.delimiter : delimiter)
    .filter((entry) => entry.length > 0);
  const extensions = (host.pathExtensions ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension.startsWith("."));
  const found = await Promise.all(
    tools.map(async (tool) => {
      const names = onWindows ? extensions.map((extension) => tool + extension) : [tool];
      for (const directory of directories) {
        for (const name of names) {
          try {
            await access(join(directory, name), constants.X_OK);
            return tool;
          } catch {
            continue;
          }
        }
      }
      return undefined;
    }),
  );
  return found.filter((tool): tool is string => tool !== undefined);
}
