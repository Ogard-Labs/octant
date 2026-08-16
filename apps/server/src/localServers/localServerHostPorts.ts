import type { LocalServerHealth } from "@octant/contracts";
import type { LocalServerHealthProbe, LocalServerStopPort } from "./localServerService";

/** A probe is a liveness question, not a page load; keep it short. */
const PROBE_TIMEOUT_MS = 1_500;
/** Graceful window before a classified leftover is forced. */
const STOP_GRACE_MS = 3_000;
const STOP_POLL_INTERVAL_MS = 100;

export interface LiveLocalServerHealthProbeOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/**
 * Distinguish a listener that answers from one that merely holds the port.
 *
 * HTTP is tried first because that is what a dev server almost always serves;
 * HTTPS is tried only when HTTP fails, which is how an HTTPS-only listener is
 * discovered without ever downgrading a request. A listener that answers *any*
 * status — including 404 or 500 — is healthy: an API backend with no route at
 * `/` is still a server worth opening. Only a transport failure is `wedged`.
 *
 * The probe follows the family the host actually observed the socket bound to:
 * a dev server bound only to `::1` answers on the IPv6 loopback and nowhere
 * else, so asking 127.0.0.1 would report a healthy server as wedged and
 * withhold Open from it. Both families are tried only when the observation
 * genuinely names neither (`lsof`'s `*:3000`), and the host that answered is
 * reported back so the caller opens the endpoint that actually replied.
 */
export function createLiveLocalServerHealthProbe(
  options: LiveLocalServerHealthProbeOptions = {},
): LocalServerHealthProbe {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  return {
    async probe(input) {
      const hosts = loopbackHostsFor(input.bindAddress);
      for (const scheme of ["http", "https"] as const) {
        for (const host of hosts) {
          // An abandoned scan gets no further attempts; the caller is gone.
          if (input.signal?.aborted === true) return noAnswer(hosts, "unknown");
          const health = await attempt(
            fetchImpl,
            `${scheme}://${formatHost(host)}:${input.port}/`,
            timeoutMs,
            input.signal,
          );
          if (health === "listening") return { scheme, host, health };
        }
      }
      // Every scheme and family was asked and none answered — unless the scan
      // was abandoned during the last of them, which settles nothing.
      return noAnswer(hosts, input.signal?.aborted === true ? "unknown" : "unresponsive");
    },
  };
}

/** IPv4 loopback, IPv6 loopback, or both when the observation names neither. */
function loopbackHostsFor(bindAddress: string | undefined): ReadonlyArray<string> {
  const address = bindAddress?.trim() ?? "";
  // `*` and `localhost` cover both families; an empty observation names none.
  if (address === "" || address === "*" || address === "localhost") return ["127.0.0.1", "::1"];
  // Anything with a colon is an IPv6 literal — `::1`, the `::` wildcard, or a
  // routable address whose loopback counterpart is still the IPv6 one.
  return address.includes(":") ? ["::1"] : ["127.0.0.1"];
}

/** An IPv6 host is only a valid URL authority in brackets. */
function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * No listening answer, at the endpoint that was asked first.
 *
 * The two callers differ in what they established, not in what they found:
 * `unresponsive` means every scheme and family was asked and none answered,
 * while `unknown` means the scan was abandoned before the question was finished
 * — a listener that would have answered on HTTPS or the other loopback family
 * must not be published as one that held its port in silence.
 */
function noAnswer(
  hosts: ReadonlyArray<string>,
  health: "unresponsive" | "unknown",
): {
  readonly scheme: "http";
  readonly host: string;
  readonly health: LocalServerHealth;
} {
  return { scheme: "http", host: hosts[0] ?? "127.0.0.1", health };
}

async function attempt(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<LocalServerHealth> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
  try {
    await fetchImpl(url, { method: "GET", redirect: "manual", signal });
    return "listening";
  } catch (error) {
    // A dev server on HTTPS almost always presents a self-signed localhost
    // certificate the host's trust store will not verify. The probe never
    // relaxes that verification: it reads the refusal as the answer it is —
    // a TLS server completed a handshake on this port and named a certificate,
    // which is exactly the "listening" the panel needs before offering Open.
    // Accepting that one certificate stays a decision for the isolated Browser
    // context, not a property of this process.
    return isCertificateRefusal(error) ? "listening" : "unresponsive";
  }
}

/**
 * X.509 verification failures, as OpenSSL names them through Node/Bun `fetch`.
 * Only certificate *verification* codes qualify. A handshake that timed out, a
 * reset, or a refused connection proves nothing answered, so those stay
 * `unresponsive` and Open stays withheld.
 */
const CERTIFICATE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
]);

/** `fetch` wraps the TLS failure, so the cause chain carries the real code. */
function isCertificateRefusal(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 4; depth += 1) {
    const code = errorCode(current);
    if (code !== undefined && CERTIFICATE_REFUSAL_CODES.has(code)) return true;
    if (typeof current !== "object" || current === null || !("cause" in current)) return false;
    current = (current as { readonly cause: unknown }).cause;
  }
  return false;
}

export interface LiveLocalServerStopPortOptions {
  readonly kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly graceMs?: number;
}

/**
 * Stop a classified server by its process group: SIGTERM, a bounded wait, then
 * SIGKILL only if it is still alive. Signalling the group rather than the pid
 * is what actually reclaims the port when a dev server has spawned workers.
 *
 * Waiting follows the same target that was signalled. A group leader routinely
 * exits while a worker keeps the listener bound, so watching the leader alone
 * would call the port free while it is still held; watching the group answers
 * for every member and escalates until the group itself is gone.
 *
 * A failure is reported as a failure. This port never escalates further and
 * never retries destructively — the caller surfaces the failure to the user
 * instead of hammering an unknown process.
 */
export function createLiveLocalServerStopPort(
  options: LiveLocalServerStopPortOptions = {},
): LocalServerStopPort {
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const graceMs = options.graceMs ?? STOP_GRACE_MS;

  return {
    async stop({ pid }) {
      if (!Number.isSafeInteger(pid) || pid <= 1) return "failed";
      const target = signalledTarget(kill, pid, "SIGTERM");
      if (target === undefined) return "failed";

      const deadline = now() + graceMs;
      while (now() < deadline) {
        if (!isAlive(kill, target)) return "stopped";
        await sleep(STOP_POLL_INTERVAL_MS);
      }
      if (!isAlive(kill, target)) return "stopped";
      if (!sendSignal(kill, target, "SIGKILL")) return "failed";
      await sleep(STOP_POLL_INTERVAL_MS);
      return isAlive(kill, target) ? "failed" : "stopped";
    },
  };
}

/**
 * Signal the process group, falling back to the pid alone, and report which
 * target actually took the signal so the wait and the escalation address that
 * same target rather than assuming a group was reached.
 */
function signalledTarget(
  kill: (pid: number, signal: NodeJS.Signals | 0) => void,
  pid: number,
  toSend: NodeJS.Signals,
): number | undefined {
  if (sendSignal(kill, -pid, toSend)) return -pid;
  // A process that is not its own group leader is signalled directly.
  if (sendSignal(kill, pid, toSend)) return pid;
  return undefined;
}

function sendSignal(
  kill: (pid: number, signal: NodeJS.Signals | 0) => void,
  target: number,
  toSend: NodeJS.Signals,
): boolean {
  try {
    kill(target, toSend);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the signalled target still exists. A negative target asks the whole
 * group, which answers while any member survives — including after the leader
 * that named the group has exited.
 *
 * Only `ESRCH` proves nothing is there. `EPERM` says the target is very much
 * alive and merely not ours to signal, and an unrecognised failure proves
 * nothing at all; reading either as a stop would free a port that is still held.
 */
function isAlive(kill: (pid: number, signal: NodeJS.Signals | 0) => void, target: number): boolean {
  try {
    kill(target, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code: unknown = (error as { readonly code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
