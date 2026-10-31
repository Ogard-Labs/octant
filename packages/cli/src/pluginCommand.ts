import {
  decodeExtensionCommandResult,
  decodeExtensionSnapshot,
  type ExtensionCommandResult,
} from "@octant/contracts/extension-rpc";
import { failureMessage, type OpenedLocalControlSession } from "./localControl";

/**
 * `octant plugin install npm:<package>[@<version or range>]` and
 * `octant plugin check-update <package>`.
 *
 * The CLI decides nothing about a package. It asks the running host to look
 * the package up on the registry the person's npm settings name, prints what
 * the host found, and asks the host to install that exact version. Installing
 * adds the package untrusted and switched off; trusting and enabling it stay
 * with the Octant window on this computer.
 */

export type PluginCliCommand =
  | { readonly action: "install"; readonly packageName: string; readonly range?: string }
  | { readonly action: "check-update"; readonly packageName: string };

export function resolvePluginCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): PluginCliCommand | undefined {
  const [action, target, ...rest] = positional;
  if (Object.keys(flags).length > 0 || target === undefined || rest.length > 0) return undefined;
  if (action === "install") {
    if (!target.startsWith("npm:")) return undefined;
    const spec = target.slice("npm:".length);
    // The version starts at the last `@` that is not the scope's own.
    const at = spec.lastIndexOf("@");
    const packageName = at > 0 ? spec.slice(0, at) : spec;
    const range = at > 0 ? spec.slice(at + 1) : undefined;
    if (packageName === "" || range === "") return undefined;
    return { action: "install", packageName, ...(range === undefined ? {} : { range }) };
  }
  if (action === "check-update") {
    const packageName = target.startsWith("npm:") ? target.slice("npm:".length) : target;
    return packageName === "" ? undefined : { action: "check-update", packageName };
  }
  return undefined;
}

export interface RunPluginCliCommandInput {
  readonly command: PluginCliCommand;
  readonly session: OpenedLocalControlSession;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
}

export async function runPluginCliCommand(input: RunPluginCliCommandInput): Promise<number> {
  const { command, session, stdout, stderr } = input;
  if (command.action === "check-update") {
    const snapshot = await session.send({ path: "/api/extensions/snapshot", method: "POST" });
    let installed;
    try {
      installed = decodeExtensionSnapshot(snapshot.body).packages.find(
        (candidate) => candidate.npm?.packageName === command.packageName,
      );
    } catch {
      stderr.write("Octant returned an answer this command cannot read.\n");
      return 1;
    }
    if (installed?.npm === undefined) {
      stderr.write(`No installed plugin came from the npm package ${command.packageName}.\n`);
      return 1;
    }
    const checked = await ask(session, {
      kind: "check-npm-update",
      extensionId: installed.extensionId,
    });
    if (checked.kind === "extension-command-failed") {
      stderr.write(`${checked.failure.message}\n`);
      return 1;
    }
    if (checked.kind !== "npm-update-checked") {
      stderr.write("Octant returned an answer this command cannot read.\n");
      return 1;
    }
    stdout.write(
      checked.available === undefined
        ? `${command.packageName}@${checked.installedVersion} is the newest version the registry offers.\n`
        : `${command.packageName}@${checked.installedVersion} is installed; ${checked.available} is available.\nNothing was installed. Review and update it in the Octant window.\n`,
    );
    return 0;
  }

  const looked = await ask(session, {
    kind: "resolve-npm-package",
    packageName: command.packageName,
    ...(command.range === undefined ? {} : { range: command.range }),
  });
  if (looked.kind === "extension-command-failed") {
    stderr.write(`${looked.failure.message}\n`);
    return 1;
  }
  if (looked.kind !== "package-inspected") {
    stderr.write("Octant returned an answer this command cannot read.\n");
    return 1;
  }
  const { entry, review } = looked.preview;
  stdout.write(`${entry.displayName} ${entry.version} from npm\n`);
  if (review.provenance.npm !== undefined) {
    stdout.write(
      `  package    ${review.provenance.npm.packageName}@${review.provenance.npm.version}\n`,
    );
    stdout.write(`  registry   ${review.provenance.npm.registry}\n`);
    stdout.write(`  integrity  ${review.provenance.npm.integrity}\n`);
  }
  if (review.provenance.publisherKey !== undefined) {
    stdout.write(`  signed by  ${review.provenance.publisherKey}\n`);
  }
  for (const component of review.components) {
    stdout.write(`  contains   ${component.displayName} (${component.kind})\n`);
  }
  const installed = await ask(
    session,
    {
      kind: "install-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
      version: entry.version,
      digest: entry.digest,
    },
    "/api/extensions/lifecycle",
  );
  if (installed.kind === "extension-command-failed") {
    stderr.write(`${installed.failure.message}\n`);
    return 1;
  }
  stdout.write(
    "Installed. It is untrusted and switched off; Octant ran nothing from it.\nTrust and enable it in the Octant window on this computer.\n",
  );
  return 0;
}

async function ask(
  session: OpenedLocalControlSession,
  command: Record<string, unknown>,
  path = "/api/extensions/npm",
): Promise<ExtensionCommandResult> {
  const response = await session.send({ path, method: "POST", body: command });
  try {
    return decodeExtensionCommandResult(response.body);
  } catch {
    return {
      kind: "extension-command-failed",
      failure: {
        category: "unavailable",
        message: failureMessage(response, "Octant did not answer this request."),
      },
    };
  }
}
