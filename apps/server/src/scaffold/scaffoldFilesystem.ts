import { access, lstat, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

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
 * approved yet.
 */
export async function resolveAvailableTools(
  tools: ReadonlyArray<string>,
  environmentPath: string | undefined = process.env["PATH"],
): Promise<ReadonlyArray<string>> {
  const directories = (environmentPath ?? "").split(delimiter).filter((entry) => entry.length > 0);
  const found = await Promise.all(
    tools.map(async (tool) => {
      for (const directory of directories) {
        try {
          await access(join(directory, tool), constants.X_OK);
          return tool;
        } catch {
          continue;
        }
      }
      return undefined;
    }),
  );
  return found.filter((tool): tool is string => tool !== undefined);
}
