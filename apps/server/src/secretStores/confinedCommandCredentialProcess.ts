import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandCredentialBinding } from "@octant/contracts/command-credentials";
import { onePasswordCommandCredentials } from "@octant/host-runtime";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { DEFERRED_PROXY_SOURCE } from "../process/deferredProxyEnvironment";
import { makeProcessConfinementLive } from "../process/seatbeltProfile";
import type { ProxiedNetworkEgress } from "../process/threadEgressPolicy";

/** op authenticates outside; its only child is the host-prepared recipient capsule. */
export function confinedCommandCredentialProcess(options: {
  readonly binding: CommandCredentialBinding;
  readonly recipientIdentity: string;
  /** The Code checkout; the binding's directory may be a subdirectory of it. */
  readonly checkoutRoot: string;
  readonly networkEgress: ProxiedNetworkEgress;
  readonly proxyUrl: string;
  readonly temporaryDirectory: string;
  readonly receiptDirectory: string;
}) {
  const confinement = makeProcessConfinementLive();
  const home = homedir();
  const credentialRoots = [join(home, ".op"), join(home, ".config", "op")];
  const port = new RepositoryTestProcessPort({
    temporaryDirectory: options.temporaryDirectory,
    receiptDirectory: options.receiptDirectory,
    networkEgress: options.networkEgress,
    confinement: {
      prepare: (input) => {
        const capsule = confinement.prepare({
          ...input,
          // The launch binds its cwd, the binding's directory. Ordinary Code commands
          // may write the whole checkout, so a build started in a package directory
          // could not write a shared output at the root; grant the checkout as the
          // bound root's equal while keeping the cwd for chdir and the masks below.
          ...(input.boundRoot === options.checkoutRoot
            ? {}
            : {
                extraBoundRoots: [...(input.extraBoundRoots ?? []), options.checkoutRoot],
                readRoots: [...(input.readRoots ?? []), options.checkoutRoot],
              }),
          ownAccountAccess: "none",
          isolatedRoots: [...(input.isolatedRoots ?? []), ...credentialRoots],
          // Bubblewrap consumes these as masks; isolatedRoots is Seatbelt-only.
          additionalDenyReadPaths: [...(input.additionalDenyReadPaths ?? []), ...credentialRoots],
          recipientAdmission: {
            digest: options.binding.executableDigest,
            identity: options.recipientIdentity,
          },
        });
        const launch = onePasswordCommandCredentials({
          ...options.binding.definition,
          executable: capsule.command,
          args: capsule.args,
        });
        return { command: options.binding.credentialExecutable, args: launch.args };
      },
    },
  });
  return {
    process: port,
    environment: {
      [DEFERRED_PROXY_SOURCE]: options.proxyUrl,
      ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
    },
  };
}
