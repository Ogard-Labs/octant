import {
  CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_DAYS,
  CODE_PROJECT_PULL_REQUEST_WATCH_MAX_WAKES,
  DEFAULT_COORDINATOR_ROUNDS,
  DEFAULT_COORDINATOR_WAKES_PER_HOUR,
  DEFAULT_THREAD_WAKEUPS_WAITING,
  MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_ATTEMPTS_SETTING,
  MAX_CODE_PROJECT_PULL_REQUEST_WATCH_DAYS_SETTING,
  MAX_CODE_PROJECT_PULL_REQUEST_WATCH_WAKES_SETTING,
  MAX_COORDINATOR_ROUNDS,
  MAX_COORDINATOR_WAKES_PER_HOUR,
  MAX_COORDINATORS_PER_PROJECT,
  MAX_COORDINATORS_PER_PROJECT_SETTING,
  MAX_THREAD_WAKEUPS_WAITING_SETTING,
} from "@octant/contracts";
import {
  DEFAULT_BROWSER_WAIT_LIMIT_MINUTES,
  MAX_BROWSER_WAIT_LIMIT_MINUTES_SETTING,
} from "@octant/contracts/browser-automation";
import {
  DEFAULT_CHILD_RUN_WAIT_LIMIT_SECONDS,
  DEFAULT_FOLLOW_UP_LATENESS_LIMIT_HOURS,
  DEFAULT_SHIELD_DENIALS_IN_A_ROW,
  DEFAULT_SHIELD_DENIALS_PER_THREAD,
  DEFAULT_TOOLING_COMMAND_CONFIRM_MINUTES,
  MAX_FOLLOW_UP_LATENESS_LIMIT_HOURS_SETTING,
  MAX_SHIELD_DENIALS_IN_A_ROW_SETTING,
  MAX_SHIELD_DENIALS_PER_THREAD_SETTING,
  MAX_TOOLING_COMMAND_CONFIRM_MINUTES_SETTING,
  DEFAULT_SIBLING_THREAD_READS_PER_TURN,
  DEFAULT_SIBLING_THREAD_WAITS_PER_TURN,
  DEFAULT_THREAD_MESSAGES_PER_TURN,
  MAX_CHILD_RUN_WAIT_LIMIT_SECONDS_SETTING,
  MAX_SIBLING_THREAD_READS_PER_TURN_SETTING,
  MAX_SIBLING_THREAD_WAITS_PER_TURN_SETTING,
  MAX_THREAD_MESSAGES_PER_TURN_SETTING,
  type ShellSettings,
} from "@octant/contracts/shell";
import { OctantNumberStepper } from "../ui/base/OctantNumberStepper";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow, SettingsSection } from "./primitives";
import { settingId } from "./registry";

type LimitKey =
  | "threadWakeupsWaitingLimit"
  | "messageWakesPerHour"
  | "messageWakeRounds"
  | "coordinatorsPerProject"
  | "pullRequestWatchWakeLimit"
  | "pullRequestWatchDays"
  | "autoFixAttemptsPerFailure"
  | "threadMessagesPerTurn"
  | "siblingThreadReadsPerTurn"
  | "siblingThreadWaitsPerTurn"
  | "browserWaitLimitMinutes"
  | "childRunWaitLimitSeconds"
  | "shieldDenialsInARow"
  | "shieldDenialsPerThread"
  | "followUpLatenessLimitHours"
  | "toolingCommandConfirmMinutes";

interface LimitRow {
  readonly key: LimitKey;
  readonly id: string;
  readonly label: string;
  /** One sentence: what the number counts. */
  readonly description: string;
  /** What else a person may need before changing it, behind the row's More. */
  readonly more?: string;
  readonly defaultValue: number;
  readonly max: number;
}

/** What a Strict-only limit's More says: the row's sentence already names Strict. */
const STRICT_ONLY = "Outside Strict there is no limit.";

/**
 * Octant's own limits that protect no hard line, each a host setting the
 * person may change (docs/architecture.md, Octant's own limits become
 * settings). The server reads each one where it applies; this page only
 * shows and replaces them through the ordinary journaled settings write.
 */
const SECTIONS: ReadonlyArray<{ readonly title: string; readonly rows: ReadonlyArray<LimitRow> }> =
  [
    {
      title: "Wake-ups and messages",
      rows: [
        {
          key: "threadWakeupsWaitingLimit",
          id: "thread-wakeups-waiting",
          label: "Wake-ups waiting per thread",
          description:
            "How many wake-ups an agent may have waiting in one thread, missed ones included.",
          more: "A recurring wake-up may fire as often as every minute.",
          defaultValue: DEFAULT_THREAD_WAKEUPS_WAITING,
          max: MAX_THREAD_WAKEUPS_WAITING_SETTING,
        },
        {
          key: "messageWakesPerHour",
          id: "message-wakes-per-hour",
          label: "Message wakes per hour",
          description:
            "How many turns messages from other threads may start in one thread in an hour.",
          more: "A coordinator may set its own number for its threads, which applies instead.",
          defaultValue: DEFAULT_COORDINATOR_WAKES_PER_HOUR,
          max: MAX_COORDINATOR_WAKES_PER_HOUR,
        },
        {
          key: "messageWakeRounds",
          id: "message-wake-rounds",
          label: "Rounds of replies that wake",
          description:
            "How many times threads may answer each other before a message waits for the next turn instead of starting one.",
          defaultValue: DEFAULT_COORDINATOR_ROUNDS,
          max: MAX_COORDINATOR_ROUNDS,
        },
        {
          key: "threadMessagesPerTurn",
          id: "thread-messages-per-turn",
          label: "Thread messages per turn",
          description:
            "Under Strict, how many times one turn may ask another thread you mentioned.",
          more: STRICT_ONLY,
          defaultValue: DEFAULT_THREAD_MESSAGES_PER_TURN,
          max: MAX_THREAD_MESSAGES_PER_TURN_SETTING,
        },
        {
          key: "siblingThreadReadsPerTurn",
          id: "sibling-thread-reads-per-turn",
          label: "Sibling thread reads per turn",
          description:
            "Under Strict, how many times one turn may read another open thread in the same Project.",
          more: STRICT_ONLY,
          defaultValue: DEFAULT_SIBLING_THREAD_READS_PER_TURN,
          max: MAX_SIBLING_THREAD_READS_PER_TURN_SETTING,
        },
        {
          key: "siblingThreadWaitsPerTurn",
          id: "sibling-thread-waits-per-turn",
          label: "Sibling thread waits per turn",
          description:
            "Under Strict, how many times one turn may wait on another open thread in the same Project.",
          more: STRICT_ONLY,
          defaultValue: DEFAULT_SIBLING_THREAD_WAITS_PER_TURN,
          max: MAX_SIBLING_THREAD_WAITS_PER_TURN_SETTING,
        },
      ],
    },
    {
      title: "Octant Shield",
      rows: [
        {
          key: "shieldDenialsInARow",
          id: "shield-denials-in-a-row",
          label: "Denials in a row before you decide",
          description:
            "After Octant Shield denies this many calls in a row in one thread, the next call comes to you.",
          defaultValue: DEFAULT_SHIELD_DENIALS_IN_A_ROW,
          max: MAX_SHIELD_DENIALS_IN_A_ROW_SETTING,
        },
        {
          key: "shieldDenialsPerThread",
          id: "shield-denials-per-thread",
          label: "Denials per thread before you decide",
          description:
            "After Octant Shield denies this many calls in one thread, every later call there comes to you.",
          defaultValue: DEFAULT_SHIELD_DENIALS_PER_THREAD,
          max: MAX_SHIELD_DENIALS_PER_THREAD_SETTING,
        },
      ],
    },
    {
      title: "Coordinators",
      rows: [
        {
          key: "coordinatorsPerProject",
          id: "coordinators-per-project",
          label: "Coordinators per Project",
          description:
            "How many coordinator threads one Code Project may have, its planner included.",
          more: "Lowering it stops no coordinator that already exists.",
          defaultValue: MAX_COORDINATORS_PER_PROJECT,
          max: MAX_COORDINATORS_PER_PROJECT_SETTING,
        },
      ],
    },
    {
      title: "Pull requests",
      rows: [
        {
          key: "pullRequestWatchWakeLimit",
          id: "pull-request-watch-wakes",
          label: "Wakes per pull-request watch",
          description:
            "Limits turns started by a pull-request watch and feedback turns started by a babysitter.",
          defaultValue: CODE_PROJECT_PULL_REQUEST_WATCH_MAX_WAKES,
          max: MAX_CODE_PROJECT_PULL_REQUEST_WATCH_WAKES_SETTING,
        },
        {
          key: "pullRequestWatchDays",
          id: "pull-request-watch-days",
          label: "Days a pull-request watch lasts",
          description: "A watch ends this many days after it began.",
          defaultValue: CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_DAYS,
          max: MAX_CODE_PROJECT_PULL_REQUEST_WATCH_DAYS_SETTING,
        },
        {
          key: "autoFixAttemptsPerFailure",
          id: "auto-fix-attempts",
          label: "Auto-fix tries per failure",
          description:
            "Auto-fix hands a pull request back to you after this many tries on the same failure.",
          defaultValue: CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
          max: MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_ATTEMPTS_SETTING,
        },
      ],
    },
    {
      title: "Waiting",
      rows: [
        {
          key: "browserWaitLimitMinutes",
          id: "browser-wait-limit",
          label: "Longest Browser wait, in minutes",
          description:
            "Under Strict, how long an agent's Browser may wait for a page to show something.",
          more: "Outside Strict there is no wait limit. A Claude Code thread still ends any one tool call after eleven minutes.",
          defaultValue: DEFAULT_BROWSER_WAIT_LIMIT_MINUTES,
          max: MAX_BROWSER_WAIT_LIMIT_MINUTES_SETTING,
        },
        {
          key: "followUpLatenessLimitHours",
          id: "follow-up-lateness-limit",
          label: "Latest a follow-up still runs, in hours",
          description:
            "How many hours late a follow-up still runs when this computer was asleep or its thread was busy.",
          more: "A follow-up later than that is recorded as missed.",
          defaultValue: DEFAULT_FOLLOW_UP_LATENESS_LIMIT_HOURS,
          max: MAX_FOLLOW_UP_LATENESS_LIMIT_HOURS_SETTING,
        },
        {
          key: "toolingCommandConfirmMinutes",
          id: "tooling-command-confirm",
          label: "Time to run a shown provider command, in minutes",
          description:
            "How long Run this command once stays available after Skills & Extensions shows a Claude Code or Codex command.",
          more: "A secret held for the command is deleted when the time runs out.",
          defaultValue: DEFAULT_TOOLING_COMMAND_CONFIRM_MINUTES,
          max: MAX_TOOLING_COMMAND_CONFIRM_MINUTES_SETTING,
        },
        {
          key: "childRunWaitLimitSeconds",
          id: "child-run-wait-limit",
          label: "Longest wait for a helper, in seconds",
          description:
            "How long an agent may wait for a helper agent in one call before it hears the helper is still working.",
          defaultValue: DEFAULT_CHILD_RUN_WAIT_LIMIT_SECONDS,
          max: MAX_CHILD_RUN_WAIT_LIMIT_SECONDS_SETTING,
        },
      ],
    },
  ];

function limitPatch(key: LimitKey, value: number): Partial<ShellSettings> {
  const patch: Partial<Record<LimitKey, number>> = {};
  patch[key] = value;
  return patch;
}

export function OctantLimitsSettings(props: {
  readonly settings: ShellSettings;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => void;
  readonly focusedSetting: string | undefined;
}) {
  return (
    <>
      {SECTIONS.map((section) => (
        <SettingsSection key={section.title} title={section.title}>
          <div className="setgroup">
            {section.rows.map((row) => (
              <SettingRow
                atDefault={props.settings[row.key] === row.defaultValue}
                defaultValue={String(row.defaultValue)}
                description={row.description}
                focused={props.focusedSetting === settingId(row.id)}
                key={row.key}
                label={row.label}
                {...(row.more === undefined ? {} : { more: row.more })}
                scope="host"
                settingId={row.id}
              >
                <OctantNumberStepper
                  label={row.label}
                  max={row.max}
                  min={1}
                  onChange={(value) => props.onSettingsChange(limitPatch(row.key, value))}
                  value={props.settings[row.key]}
                />
              </SettingRow>
            ))}
            {section.title === "Wake-ups and messages" ? (
              <SettingRow
                description="A wake-up that came due while this computer was off or asleep runs once when Octant is back."
                more="Off, it is shown as missed and waits for you to run or cancel it."
                focused={props.focusedSetting === settingId("thread-wakeups-run-missed")}
                label="Run missed wake-ups on return"
                scope="host"
                settingId="thread-wakeups-run-missed"
              >
                <OctantSwitch
                  checked={props.settings.threadWakeupsRunMissedOnReturn}
                  label="Run missed wake-ups on return"
                  onCheckedChange={(checked) =>
                    props.onSettingsChange({ threadWakeupsRunMissedOnReturn: checked })
                  }
                />
              </SettingRow>
            ) : null}
          </div>
        </SettingsSection>
      ))}
      <SettingsSection title="Routines">
        <div className="setgroup">
          <SettingRow
            description="A routine an agent suggests while its thread runs at Full access starts enabled, with no card."
            more="Off, it is created paused and waits for you to turn it on. A routine you asked for starts enabled at every level, and below Full access a suggested one waits for you to confirm its card."
            focused={props.focusedSetting === settingId("agent-routines-start-active")}
            label="Start agent-created routines active at Full access"
            scope="host"
            settingId="agent-routines-start-active"
          >
            <OctantSwitch
              checked={props.settings.agentRoutinesStartActiveAtFullAccess}
              label="Start agent-created routines active at Full access"
              onCheckedChange={(checked) =>
                props.onSettingsChange({ agentRoutinesStartActiveAtFullAccess: checked })
              }
            />
          </SettingRow>
        </div>
      </SettingsSection>
    </>
  );
}
