import { failureMessage, type OpenedLocalControlSession } from "./localControl";

// Spelled out so each served route has a caller the wiring check can find.
const PROVIDER_SIGN_IN_ROUTES = {
  begin: "/api/desktop/provider-sign-in/begin",
  poll: "/api/desktop/provider-sign-in/poll",
} as const;

const DEFAULT_POLL_INTERVAL_MS = 2_000;
// The host stops following an attempt a minute after its code runs out.
const EXPIRY_GRACE_MS = 60_000;
// What the person types and reads must be plain: a code or a page that could
// carry terminal control characters is refused rather than printed.
const USER_CODE_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export interface ProviderSignInCliCommand {
  readonly instance: string;
}

/**
 * `octant provider sign-in <instance>`: sign an organization endpoint in with
 * a device code, for a host without the desktop app. It takes no flags; the
 * instance must already allow a device-code sign-in in its Settings.
 */
export function resolveProviderSignInCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): ProviderSignInCliCommand | undefined {
  const [noun, instance, ...rest] = positional;
  if (
    noun !== "sign-in" ||
    instance === undefined ||
    instance.trim() === "" ||
    rest.length !== 0 ||
    Object.keys(flags).length !== 0
  ) {
    return undefined;
  }
  return { instance };
}

export interface RunProviderSignInCliCommandInput {
  readonly command: ProviderSignInCliCommand;
  readonly session: OpenedLocalControlSession;
  /** Asks the person one question; absent when no terminal can answer. */
  readonly ask: ((question: string) => Promise<string | undefined>) | undefined;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
}

export async function runProviderSignInCliCommand(
  input: RunProviderSignInCliCommandInput,
): Promise<number> {
  const { command, session } = input;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const begin = (acknowledgeTerms: boolean) =>
    session.send({
      path: PROVIDER_SIGN_IN_ROUTES.begin,
      method: "POST",
      body: { instance: command.instance, acknowledgeTerms },
    });

  let response = await begin(false);
  const terms = response.status === 200 ? termsOf(response.body) : undefined;
  if (terms !== undefined) {
    input.stdout.write(`${terms}\n`);
    if (input.ask === undefined) {
      input.stderr.write(
        "Nothing was started: run this command in a terminal to read and accept the sign-in terms.\n",
      );
      return 1;
    }
    const reply = await input.ask("Continue? [y/N] ");
    if (reply === undefined || !/^y(es)?$/i.test(reply.trim())) {
      input.stderr.write("Nothing was started.\n");
      return 1;
    }
    response = await begin(true);
  }
  if (response.status !== 200) {
    input.stderr.write(`${describeRefusal(response, command)}\n`);
    return 1;
  }
  const code = awaitingCodeOf(response.body);
  if (code === undefined) {
    input.stderr.write("Octant returned an unusable answer.\n");
    return 1;
  }
  const minutes = Math.max(1, Math.round((code.expiresAt - now()) / 60_000));
  input.stdout.write(
    [
      `Sign ${code.name} in with your organization account:`,
      `  1. On any device, open ${code.verificationUri}`,
      `  2. Enter the code ${code.userCode}`,
      code.warning,
      `The code works for about ${minutes} minute${minutes === 1 ? "" : "s"}. Waiting for the sign-in to finish (Ctrl-C stops waiting; a sign-in you finish before the code runs out still completes).`,
      "",
    ].join("\n"),
  );

  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (now() < code.expiresAt + EXPIRY_GRACE_MS) {
    await sleep(pollIntervalMs);
    const polled = await session.send({
      path: PROVIDER_SIGN_IN_ROUTES.poll,
      method: "POST",
      body: { instance: command.instance, attemptId: code.attemptId },
    });
    if (polled.status !== 200) {
      input.stderr.write(`${describeRefusal(polled, command)}\n`);
      return 1;
    }
    const outcome = pollOutcomeOf(polled.body);
    if (outcome === undefined) {
      input.stderr.write("Octant returned an unusable answer.\n");
      return 1;
    }
    if (outcome.kind === "signed-in") {
      input.stdout.write(`${code.name} is signed in as ${outcome.accountLabel}.\n`);
      return 0;
    }
  }
  input.stderr.write(
    "The code ran out before the sign-in finished, so nothing was saved. Run the command again for a new code.\n",
  );
  return 1;
}

function termsOf(body: unknown): string | undefined {
  const record = recordOf(body);
  return record?.outcome === "terms-required" && typeof record.termsSummary === "string"
    ? record.termsSummary
    : undefined;
}

interface AwaitingCode {
  readonly name: string;
  readonly attemptId: string;
  readonly verificationUri: string;
  readonly userCode: string;
  readonly expiresAt: number;
  readonly warning: string;
}

function awaitingCodeOf(body: unknown): AwaitingCode | undefined {
  const record = recordOf(body);
  if (record === undefined || record.outcome !== "awaiting-code") return undefined;
  const { attemptId, verificationUri, userCode, expiresAt, warning } = record;
  if (
    typeof attemptId !== "string" ||
    typeof verificationUri !== "string" ||
    !isHttpsPage(verificationUri) ||
    typeof userCode !== "string" ||
    !USER_CODE_PATTERN.test(userCode) ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    typeof warning !== "string"
  ) {
    return undefined;
  }
  return {
    name: nameOf(record),
    attemptId,
    verificationUri,
    userCode,
    expiresAt: Date.parse(expiresAt),
    warning,
  };
}

type PollOutcome =
  | { readonly kind: "waiting" }
  | { readonly kind: "signed-in"; readonly accountLabel: string };

function pollOutcomeOf(body: unknown): PollOutcome | undefined {
  const record = recordOf(body);
  if (record?.outcome === "waiting") return { kind: "waiting" };
  if (record?.outcome === "signed-in" && typeof record.accountLabel === "string") {
    return { kind: "signed-in", accountLabel: record.accountLabel };
  }
  return undefined;
}

function nameOf(record: Readonly<Record<string, unknown>>): string {
  const { instanceId, displayName } = record;
  const id = typeof instanceId === "string" ? instanceId : "the endpoint";
  return typeof displayName === "string" ? `${displayName} (${id})` : id;
}

function isHttpsPage(value: string): boolean {
  // The URL parser reads past an escape character or a line break, but the
  // terminal would not: the page is printed as it came.
  if (!/^[\x21-\x7e]{1,2048}$/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function describeRefusal(
  response: { readonly status: number; readonly body: unknown },
  command: ProviderSignInCliCommand,
): string {
  const body = recordOf(response.body) ?? {};
  switch (body.category) {
    case "not-found":
      return `No provider has the id or name "${command.instance}".`;
    case "ambiguous": {
      const candidates = Array.isArray(body.candidates) ? body.candidates : [];
      const lines = candidates.flatMap((candidate: unknown) => {
        const entry = recordOf(candidate);
        return typeof entry?.id === "string" && typeof entry.displayName === "string"
          ? [`  ${entry.id}  ${entry.displayName}`]
          : [];
      });
      return [`More than one provider is named "${command.instance}". Use its id:`, ...lines].join(
        "\n",
      );
    }
    case "no-organization-sign-in":
      return `"${command.instance}" does not sign in with an organization account, so there is nothing to sign in.`;
    case "device-code-not-enabled":
      return `"${command.instance}" does not allow signing in with a code from this host's terminal. In Octant Settings, open the endpoint, turn on "Allow sign-in with a code from this host's terminal" under Name and address, save, and run this command again.`;
    case "sign-in-refused":
      switch (body.reason) {
        case "denied":
          return "The sign-in was declined, so nothing was saved.";
        case "timeout":
          return "The code ran out before the sign-in finished, so nothing was saved. Run the command again for a new code.";
        case "exchange-refused":
          return "Your organization refused the sign-in, so nothing was saved. Its app registration must allow public client flows, and its policies may block signing in with a code.";
        default:
          return "The sign-in did not finish, so nothing was saved.";
      }
    case "sign-in-unavailable":
      return "Nothing was signed in: Octant could not reach your organization's directory or this host's credential store. Check the network and that the keyring is unlocked, then try again.";
    case "unknown-attempt":
      return "Octant no longer knows this sign-in. Run the command again.";
    case "unauthorized":
      return "Octant refused this command's local authority.";
    default:
      return failureMessage(response, "Octant refused the sign-in request.");
  }
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
