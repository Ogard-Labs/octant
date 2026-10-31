import {
  decodeAutomationThreadId,
  decodeAutomationTrigger,
  decodeProjectId,
  MAX_AUTOMATION_DISPLAY_NAME_LENGTH,
  MAX_AUTOMATION_TASK_PROMPT_LENGTH,
  ROUTINE_PROPOSAL_TOOL_NAME,
  type AutomationMissedRunPolicy,
  type OctantMode,
  type AutomationTrigger,
  type ProviderExecutionPolicy,
  type ProviderToolDefinition,
  type UtcTimestamp,
  type WindowId,
} from "@octant/contracts";
import { resolveNextAutomationOccurrence } from "@octant/domain";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { RoutineProposalService } from "./routineProposalService";

const MINUTE_MS = 60_000;

const definition: ProviderToolDefinition = {
  name: ROUTINE_PROPOSAL_TOOL_NAME,
  description: [
    "Propose a routine that starts a new thread in this Project on a schedule, with a fixed prompt, when the person asks for recurring or later work.",
    "The person sees a card with exactly what will run and when, and only their confirmation creates it; this call waits for that answer and reports confirmed (with the routine id), declined, or expired.",
    "Each run is a fresh thread in this Project with the same kind of access as a thread the person starts, always asking before effects; you cannot choose another Project or wider access.",
    'trigger "once" runs at `at` (an ISO time with Z or an offset); "interval" runs every `everyMinutes` (15 to 43200), first at `startAt` or one interval from now; "weekly" runs on `weekdays` (1 = Monday … 7 = Sunday) at `localTime` (HH:MM) in `timeZone` (an IANA zone such as Europe/Oslo).',
    'trigger "follow-up" is the exception: once, at `at`, it sends the prompt as a new turn in this same thread, so you will have this conversation then (for example "check whether the reply arrived and summarise"). It does not run if the thread is busy, done, archived, or changed by then.',
    "Otherwise the prompt must stand alone: a run has none of this conversation.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: MAX_AUTOMATION_DISPLAY_NAME_LENGTH },
      prompt: { type: "string", maxLength: MAX_AUTOMATION_TASK_PROMPT_LENGTH },
      trigger: { type: "string", enum: ["once", "interval", "weekly", "follow-up"] },
      at: { type: "string" },
      everyMinutes: { type: "integer", minimum: 15, maximum: 43_200 },
      startAt: { type: "string" },
      weekdays: {
        type: "array",
        items: { type: "integer", minimum: 1, maximum: 7 },
        minItems: 1,
        maxItems: 7,
      },
      localTime: { type: "string" },
      timeZone: { type: "string" },
      missedRuns: {
        type: "string",
        enum: ["skip", "run-once"],
        description:
          "What happens to runs missed while this computer was asleep or off: skip them (default), or run the newest once.",
      },
    },
    required: ["name", "prompt", "trigger"],
    additionalProperties: false,
  },
};

function refused(reason: string, message: string) {
  return { result: { status: "refused", reason, message }, isError: true } as const;
}

/**
 * The routine-proposal tool for one Work or Code thread's turn. It only asks:
 * the proposal waits for the person in the thread, and the routine, if any,
 * is created by their confirmation through the ordinary Automation create
 * path, never by this tool. Chat is never offered it, and a routine's own
 * unattended turn is refused it, because automation-origin execution cannot
 * author a routine.
 */
export function createRoutineProposalTools(input: {
  readonly windowId: WindowId;
  readonly thread: {
    readonly id: string;
    readonly mode: OctantMode;
    readonly projectId: string;
  };
  /**
   * Code only: the turn's posture when a call runs. Plan is read-only, so it
   * proposes nothing.
   */
  readonly readPosture?: () => ProviderExecutionPolicy | undefined;
  /**
   * Whether this turn runs as the host rather than for a person: a routine's
   * run, or a usage-limit resume the host replays. Nobody is there to confirm.
   */
  readonly isAutomationOrigin: boolean;
  readonly proposals: Pick<RoutineProposalService, "propose">;
  readonly now: () => number;
}): AppManagedToolSet {
  const mode = input.thread.mode;
  // Chat has no routines, so a Chat thread is never offered the tool, and a
  // call that names it anyway is refused here rather than reaching the host.
  if (mode === "chat") {
    return {
      definitions: [],
      execute: async () => refused("chat-has-no-routines", "Chat threads cannot create routines."),
    };
  }
  return {
    definitions: [definition],
    execute: async ({ inputJson, signal }) => {
      if (signal?.aborted) return refused("tool-interrupted", "The turn was cancelled.");
      if (input.isAutomationOrigin) {
        return refused(
          "automation-recursion",
          "A turn the host runs on its own, such as a routine's run, cannot create routines. Mention the idea in your reply instead.",
        );
      }
      if (input.readPosture?.() === "plan") {
        return refused(
          "plan-read-only",
          "Plan mode is read-only and cannot propose a routine. Describe it in the plan instead.",
        );
      }
      const parsed = parseInput(inputJson, input.now());
      if (parsed.kind === "invalid") return refused("invalid-routine-input", parsed.message);
      const outcome = await input.proposals.propose({
        windowId: input.windowId,
        proposal: {
          threadId: decodeAutomationThreadId(input.thread.id),
          mode,
          projectId: decodeProjectId(input.thread.projectId),
          displayName: parsed.name,
          taskPrompt: parsed.prompt,
          trigger: parsed.trigger,
          missedRunPolicy: parsed.missedRunPolicy,
          ...(parsed.followUp ? { targetPolicy: "same-thread" as const } : {}),
          firstRunAt: parsed.firstRunAt,
        },
        ...(signal === undefined ? {} : { signal }),
      });
      switch (outcome.status) {
        case "confirmed":
          return {
            result: {
              status: "confirmed",
              routineId: String(outcome.automationId),
              firstRunAt: parsed.firstRunAt,
              message:
                "The person confirmed it. The routine exists and is shown in Automation Center and this thread's Environment.",
            },
          };
        case "declined":
          return {
            result: { status: "declined", message: "The person declined. No routine was created." },
          };
        case "expired":
          return {
            result: {
              status: "expired",
              message: "The person did not answer in time. No routine was created.",
            },
          };
        case "cancelled":
          return {
            result: {
              status: "cancelled",
              message: "The proposal was withdrawn. Nothing was created.",
            },
            isError: true,
          };
        case "not-created":
          return refused("not-created", `The host refused to create it: ${outcome.message}`);
        case "too-many-waiting":
          return refused(
            "too-many-waiting",
            "Too many proposals are already waiting on the person. Mention this one in your reply instead.",
          );
      }
    },
  };
}

type ParsedInput =
  | {
      readonly kind: "ok";
      readonly name: string;
      readonly prompt: string;
      readonly trigger: AutomationTrigger;
      readonly missedRunPolicy: AutomationMissedRunPolicy;
      readonly followUp: boolean;
      readonly firstRunAt: UtcTimestamp;
    }
  | { readonly kind: "invalid"; readonly message: string };

function parseInput(inputJson: string, nowMs: number): ParsedInput {
  let raw: unknown;
  try {
    raw = JSON.parse(inputJson);
  } catch {
    return { kind: "invalid", message: "The tool input is not valid JSON." };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "invalid", message: "The tool input must be an object." };
  }
  const fields = new Map<string, unknown>(Object.entries(raw));
  const name = text(fields, "name");
  const prompt = text(fields, "prompt");
  if (name === "" || name.length > MAX_AUTOMATION_DISPLAY_NAME_LENGTH) {
    return {
      kind: "invalid",
      message: `A name of 1 to ${MAX_AUTOMATION_DISPLAY_NAME_LENGTH} characters is required.`,
    };
  }
  if (prompt === "" || prompt.length > MAX_AUTOMATION_TASK_PROMPT_LENGTH) {
    return {
      kind: "invalid",
      message: `A standalone prompt of 1 to ${MAX_AUTOMATION_TASK_PROMPT_LENGTH} characters is required.`,
    };
  }
  const missed = fields.get("missedRuns") ?? "skip";
  if (missed !== "skip" && missed !== "run-once") {
    return { kind: "invalid", message: 'missedRuns is "skip" or "run-once".' };
  }
  const followUp = fields.get("trigger") === "follow-up";
  const trigger = parseTrigger(fields, nowMs);
  if (trigger.kind === "invalid") return trigger;
  const now = new Date(nowMs).toISOString() as UtcTimestamp;
  const firstRunAt = resolveNextAutomationOccurrence({
    trigger: trigger.trigger,
    after: now,
    inclusive: false,
  });
  if (firstRunAt === undefined) {
    return { kind: "invalid", message: "That schedule never runs after now." };
  }
  return {
    kind: "ok",
    name,
    prompt,
    trigger: trigger.trigger,
    // A follow-up runs late rather than never, within its missed window.
    missedRunPolicy: followUp ? "run-once" : missed,
    followUp,
    firstRunAt,
  };
}

function parseTrigger(
  fields: ReadonlyMap<string, unknown>,
  nowMs: number,
):
  | { readonly kind: "ok"; readonly trigger: AutomationTrigger }
  | { readonly kind: "invalid"; readonly message: string } {
  try {
    switch (fields.get("trigger")) {
      case "once":
      case "follow-up": {
        const at = instant(fields.get("at"));
        if (at === undefined) {
          return {
            kind: "invalid",
            message: "A once trigger needs `at`, an ISO time with Z or an offset.",
          };
        }
        if (Date.parse(at) <= nowMs) return { kind: "invalid", message: "`at` is in the past." };
        return { kind: "ok", trigger: decodeAutomationTrigger({ kind: "once", scheduledAt: at }) };
      }
      case "interval": {
        const minutes = fields.get("everyMinutes");
        if (typeof minutes !== "number" || !Number.isInteger(minutes)) {
          return {
            kind: "invalid",
            message: "An interval trigger needs whole `everyMinutes` from 15 to 43200.",
          };
        }
        const startAt = fields.get("startAt");
        // The first run is one interval from now unless the agent names a
        // start, so confirming never fires a run the moment it is created.
        const anchor =
          startAt === undefined
            ? new Date(Math.ceil(nowMs / MINUTE_MS) * MINUTE_MS + minutes * MINUTE_MS).toISOString()
            : instant(startAt);
        if (anchor === undefined) {
          return { kind: "invalid", message: "`startAt` must be an ISO time with Z or an offset." };
        }
        return {
          kind: "ok",
          trigger: decodeAutomationTrigger({
            kind: "interval",
            anchorAt: anchor,
            intervalMinutes: minutes,
          }),
        };
      }
      case "weekly":
        return {
          kind: "ok",
          trigger: decodeAutomationTrigger({
            kind: "weekly-local",
            weekdays: fields.get("weekdays"),
            localTime: fields.get("localTime"),
            timeZone: fields.get("timeZone"),
          }),
        };
      default:
        return {
          kind: "invalid",
          message: 'trigger is "once", "interval", "weekly", or "follow-up".',
        };
    }
  } catch {
    return {
      kind: "invalid",
      message:
        "The schedule is not valid: interval minutes run 15 to 43200; weekly needs distinct weekdays 1 to 7, localTime HH:MM, and an IANA timeZone.",
    };
  }
}

/** An explicit instant only: a time with no zone would be read in whichever zone the host is in. */
function instant(value: unknown): string | undefined {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) return undefined;
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) return undefined;
  // Whole seconds: a schedule needs no finer grain, and the interval check is exact.
  return new Date(Math.floor(ms / 1_000) * 1_000).toISOString();
}

function text(fields: ReadonlyMap<string, unknown>, key: string): string {
  const value = fields.get(key);
  return typeof value === "string" ? value.trim() : "";
}
