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
import { MAX_BROWSER_WAIT_LIMIT_MINUTES_SETTING } from "@octant/contracts/browser-automation";
import {
  DEFAULT_CHILD_RUN_WAIT_LIMIT_SECONDS,
  DEFAULT_THREAD_MESSAGES_PER_TURN,
  MAX_CHILD_RUN_WAIT_LIMIT_SECONDS_SETTING,
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
  | "browserWaitLimitMinutes"
  | "childRunWaitLimitSeconds";

interface LimitRow {
  readonly key: LimitKey;
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly max: number;
}

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
          description: `How many wake-ups an agent may have waiting in one thread, missed ones included. Default ${DEFAULT_THREAD_WAKEUPS_WAITING}. A recurring wake-up may fire as often as every minute.`,
          max: MAX_THREAD_WAKEUPS_WAITING_SETTING,
        },
        {
          key: "messageWakesPerHour",
          id: "message-wakes-per-hour",
          label: "Message wakes per hour",
          description: `How many turns messages from other threads may start in one thread in an hour, unless its coordinator set its own. Default ${DEFAULT_COORDINATOR_WAKES_PER_HOUR}.`,
          max: MAX_COORDINATOR_WAKES_PER_HOUR,
        },
        {
          key: "messageWakeRounds",
          id: "message-wake-rounds",
          label: "Rounds of replies that wake",
          description: `How many times threads may answer each other before a message is kept for the next turn instead of starting one. Default ${DEFAULT_COORDINATOR_ROUNDS}.`,
          max: MAX_COORDINATOR_ROUNDS,
        },
        {
          key: "threadMessagesPerTurn",
          id: "thread-messages-per-turn",
          label: "Thread messages per turn",
          description: `How many times one turn may ask another thread you mentioned. Default ${DEFAULT_THREAD_MESSAGES_PER_TURN}.`,
          max: MAX_THREAD_MESSAGES_PER_TURN_SETTING,
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
          description: `How many coordinator threads one Code Project may have, its planner included. Default ${MAX_COORDINATORS_PER_PROJECT}. Lowering it stops no coordinator that already exists.`,
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
          description: `A watch on a thread's pull request ends after this many turns it started. Default ${CODE_PROJECT_PULL_REQUEST_WATCH_MAX_WAKES}.`,
          max: MAX_CODE_PROJECT_PULL_REQUEST_WATCH_WAKES_SETTING,
        },
        {
          key: "pullRequestWatchDays",
          id: "pull-request-watch-days",
          label: "Days a pull-request watch lasts",
          description: `A watch ends this many days after it began. Default ${CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_DAYS}.`,
          max: MAX_CODE_PROJECT_PULL_REQUEST_WATCH_DAYS_SETTING,
        },
        {
          key: "autoFixAttemptsPerFailure",
          id: "auto-fix-attempts",
          label: "Auto-fix tries per failure",
          description: `Auto-fix hands a pull request back to you after this many tries on the same failure. Default ${CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS}.`,
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
            "How long an agent's Browser may wait for a page to show something. Default 10. A Claude Code thread still ends any one tool call after eleven minutes.",
          max: MAX_BROWSER_WAIT_LIMIT_MINUTES_SETTING,
        },
        {
          key: "childRunWaitLimitSeconds",
          id: "child-run-wait-limit",
          label: "Longest wait for a helper, in seconds",
          description: `How long an agent may wait for one of its helper agents in a single call before it hears the helper is still working. Default ${DEFAULT_CHILD_RUN_WAIT_LIMIT_SECONDS}.`,
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
                description={row.description}
                focused={props.focusedSetting === settingId(row.id)}
                key={row.key}
                label={row.label}
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
                description="A wake-up that came due while this computer was off or asleep runs once when Octant is back. Off, it is shown as missed and waits for you to run or cancel it."
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
            description="A routine an agent creates while its thread runs at Full access starts enabled instead of paused. Off, every routine an agent creates waits for you to turn it on."
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
