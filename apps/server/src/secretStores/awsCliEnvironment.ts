import { noteIssuedSecret } from "../process/secretRedaction";
import type { SecretStoreBrokerClient } from "./secretStoreBrokerClient";

/**
 * The AWS command line's environment for one command in Octant's own shell:
 * a short-lived session the broker minted from the key pair the person
 * pointed at a linked store, or nothing. Nothing is a value, not a failure:
 * the command runs and the AWS command line says it found no credentials.
 *
 * The session's secret and token are noted as issued, so a command that
 * prints them has them redacted wherever its output is kept.
 */
export async function awsCliEnvironment(
  broker: Pick<SecretStoreBrokerClient, "awsCliSession"> | undefined,
): Promise<Readonly<Record<string, string>>> {
  if (broker === undefined) return {};
  const session = await broker.awsCliSession();
  if (session.status !== "issued") return {};
  noteIssuedSecret(session.secretAccessKey);
  noteIssuedSecret(session.sessionToken);
  return {
    AWS_ACCESS_KEY_ID: session.accessKeyId,
    AWS_SECRET_ACCESS_KEY: session.secretAccessKey,
    AWS_SESSION_TOKEN: session.sessionToken,
    AWS_CREDENTIAL_EXPIRATION: session.expiration,
  };
}
