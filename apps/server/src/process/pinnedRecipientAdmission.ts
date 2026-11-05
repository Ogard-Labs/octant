import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { deferredProxyEnvironment } from "./deferredProxyEnvironment";
import { CONFINED_CREDENTIAL_RECIPIENT_BOOTSTRAP } from "./pinnedRecipientBootstrap";
import { ProcessConfinementError, type ProcessConfinementPrepareInput } from "./seatbeltProfile";

/** Only the host's own runtime may execute the fixed post-auth admission code. */
export function pinnedRecipientAdmission(input: ProcessConfinementPrepareInput) {
  const pin = input.recipientAdmission;
  if (pin === undefined) return undefined;
  if (
    typeof input.networkEgress !== "object" ||
    input.networkEgress.kind !== "proxied" ||
    !/^[a-f0-9]{64}$/.test(pin.digest) ||
    pin.identity.length === 0 ||
    pin.identity.length > 256
  ) {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Pinned recipient admission needs confined proxied network and a valid pin.",
    );
  }
  try {
    const runtime = realpathSync(process.execPath);
    accessSync(runtime, constants.X_OK);
    if (!statSync(runtime).isFile()) throw new Error("Runtime unavailable");
    return {
      runtime,
      launch: deferredProxyEnvironment(
        runtime,
        [
          "-e",
          CONFINED_CREDENTIAL_RECIPIENT_BOOTSTRAP,
          "--",
          input.executable,
          pin.digest,
          pin.identity,
          ...input.args,
        ],
        process.versions.electron === undefined ? undefined : "electron-node",
      ),
    };
  } catch {
    throw new ProcessConfinementError(
      "incompatible",
      "The host runtime cannot perform pinned recipient admission.",
    );
  }
}
