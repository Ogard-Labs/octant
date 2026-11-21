import {
  HOST_DRAIN_MAX_MINUTES,
  HostDrainStatus,
  type HostDrainRequest,
} from "@octant/contracts/host-control";
import { decodeHostAnswer } from "@octant/contracts";
import type { LocalControlResponse, OpenedLocalControlSession } from "./localControl";

/**
 * `octant server drain`: refuse new turns before an update and wait for the
 * running ones, or lift that. The host decides and counts; this command only
 * asks and reads again, so no request stays open for the minutes a wait may
 * take. An update run over SSH reads the last line it prints: `drained:`, or
 * `timed-out: <n> turns still running`.
 */
export type ServerDrainCliCommand =
  | { readonly action: "wait"; readonly minutes: number }
  | { readonly action: "lift" };

const DRAIN_PATH = "/api/host-control/drain";
const READ_EVERY_MS = 1_000;
const decodeStatus = decodeHostAnswer(HostDrainStatus);

export function resolveServerDrainCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): ServerDrainCliCommand | undefined {
  if (positional.length !== 1 || positional[0] !== "drain") return undefined;
  const names = Object.keys(flags);
  if (names.length === 1 && flags.lift === true) return { action: "lift" };
  if (names.length !== 1 || typeof flags.wait !== "string" || !/^\d{1,2}$/.test(flags.wait)) {
    return undefined;
  }
  const minutes = Number(flags.wait);
  if (minutes < 1 || minutes > HOST_DRAIN_MAX_MINUTES) return undefined;
  return { action: "wait", minutes };
}

export async function runServerDrainCliCommand(input: {
  readonly command: ServerDrainCliCommand;
  readonly session: Pick<OpenedLocalControlSession, "send">;
  readonly stdout: { write: (chunk: string) => unknown };
  readonly stderr: { write: (chunk: string) => unknown };
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<number> {
  const { command, session, stdout, stderr } = input;
  const sleep =
    input.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const ask = async (body: HostDrainRequest): Promise<HostDrainStatus | string> => {
    const response = await session.send({ path: DRAIN_PATH, method: "POST", body });
    if (response.status !== 200) return refusalOf(response);
    try {
      return decodeStatus(response.body);
    } catch {
      return "This host answered the drain with something this command cannot read.";
    }
  };

  if (command.action === "lift") {
    const lifted = await ask({ action: "lift" });
    if (typeof lifted === "string") {
      stderr.write(`${lifted}\n`);
      return 1;
    }
    stdout.write("lifted: this computer admits new turns again.\n");
    return 0;
  }

  let status = await ask({ action: "drain", minutes: command.minutes });
  let running: number | undefined;
  for (;;) {
    if (typeof status === "string") {
      stderr.write(`${status}\n`);
      return 1;
    }
    if (status.state === "drained") {
      stdout.write(`drained: no turn is running. ${REFUSING}\n`);
      return 0;
    }
    if (status.state === "timed-out") {
      stdout.write(
        `timed-out: ${turns(status.running)} still running after ${minutes(command.minutes)}. ${REFUSING}\n`,
      );
      return 0;
    }
    if (status.state === "not-draining") {
      stderr.write("The drain was lifted before running turns ended. Nothing was stopped.\n");
      return 1;
    }
    if (status.running !== running) {
      running = status.running;
      stdout.write(`draining: ${turns(status.running)} running. New turns are refused.\n`);
    }
    await sleep(READ_EVERY_MS);
    status = await ask({ action: "read" });
  }
}

const REFUSING =
  "New turns are refused until Octant stops or `octant server drain --lift` lifts the drain.";

function turns(count: number): string {
  return count === 1 ? "1 turn" : `${count} turns`;
}

function minutes(count: number): string {
  return count === 1 ? "1 minute" : `${count} minutes`;
}

function refusalOf(response: LocalControlResponse): string {
  const body = response.body;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string" && error.trim() !== "") return error;
  }
  return `This host refused the drain (HTTP ${response.status}).`;
}
