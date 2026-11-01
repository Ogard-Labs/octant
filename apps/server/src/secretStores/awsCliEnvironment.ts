import { noteIssuedSecret } from "../process/secretRedaction";
import type { SecretStoreBrokerClient } from "./secretStoreBrokerClient";

/**
 * How long a command waits for its session before it runs without one: a
 * store asking for an unlock, or a stalled broker, never holds a command.
 * Long enough for two item reads and AWS's own answer.
 */
export const AWS_CLI_SESSION_WAIT_MS = 15_000;

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
  timeoutMs = AWS_CLI_SESSION_WAIT_MS,
): Promise<Readonly<Record<string, string>>> {
  if (broker === undefined) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ readonly status: "late" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "late" }), timeoutMs);
  });
  const session = await Promise.race([broker.awsCliSession(), late]).finally(() =>
    clearTimeout(timer),
  );
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
