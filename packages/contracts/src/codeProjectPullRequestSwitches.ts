import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeThreadId } from "./code";
import {
  CodeOwnerMergeUnlockRefusal,
  CodeProjectPullRequestLabel,
  CodeProjectPullRequestMergeMethod,
} from "./codeProjectPullRequests";
import { UtcTimestamp } from "./events";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";
import { ProjectId } from "./projects";

const encoder = new TextEncoder();
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.makeFilter(
      (value) => encoder.encode(value).byteLength <= maximumBytes && !value.includes("\0"),
    ),
  );

import {
  CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_DAYS,
  CODE_PROJECT_PULL_REQUEST_WATCH_MAX_WAKES,
  MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_ATTEMPTS_SETTING,
  MAX_CODE_PROJECT_PULL_REQUEST_WATCH_DAYS_SETTING,
  MAX_CODE_PROJECT_PULL_REQUEST_WATCH_WAKES_SETTING,
} from "./octantLimits";

export {
  CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_DAYS,
  CODE_PROJECT_PULL_REQUEST_WATCH_MAX_WAKES,
  MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_ATTEMPTS_SETTING,
  MAX_CODE_PROJECT_PULL_REQUEST_WATCH_DAYS_SETTING,
  MAX_CODE_PROJECT_PULL_REQUEST_WATCH_WAKES_SETTING,
};
/** Failures one Auto-fix observation or wake names. */
export const MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_FAILURES = 32;
export const CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_MS =
  CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
/** Signals one watch baseline or wake names. */
export const MAX_CODE_PROJECT_PULL_REQUEST_WATCH_SIGNALS = 32;

/** The one pull request a switch belongs to. */
export const CodeProjectPullRequestSwitchTarget = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: PositiveInt,
});
export type CodeProjectPullRequestSwitchTarget = typeof CodeProjectPullRequestSwitchTarget.Type;

/**
 * Turns the forge's own auto-merge on or off. Turning it on names the head
 * the person saw, so the forge refuses if the branch moved in between; the
 * method is optional and, when absent, the host picks the first one the
 * repository allows (squash, merge, rebase).
 */
export const CodeProjectPullRequestMergeWhenReadyCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("enable"),
    target: CodeProjectPullRequestSwitchTarget,
    headSha: boundedNonEmptyText(64),
    method: Schema.optional(CodeProjectPullRequestMergeMethod),
    /**
     * The person's confirmation of the head they saw. A paired phone or web
     * client must send it; a local window's own click stands in for it there.
     */
    confirmed: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({
    kind: Schema.Literal("disable"),
    target: CodeProjectPullRequestSwitchTarget,
  }),
]);
export type CodeProjectPullRequestMergeWhenReadyCommand =
  typeof CodeProjectPullRequestMergeWhenReadyCommand.Type;

/** The person's completion conditions for Auto-fix on a linked pull request. */
export const PullRequestBabysitRules = Schema.Struct({
  checks: Schema.Literals(["required", "all"]),
  requiredLabel: Schema.optional(CodeProjectPullRequestLabel),
});
export type PullRequestBabysitRules = typeof PullRequestBabysitRules.Type;

/**
 * Turns Auto-fix on for one thread linked to the pull request, or off. The
 * host refuses a thread that is not linked to that pull request.
 */
export const CodeProjectPullRequestAutoFixCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("enable"),
    target: CodeProjectPullRequestSwitchTarget,
    threadId: CodeThreadId,
    babysit: Schema.optional(PullRequestBabysitRules),
    expectedStoppedAt: Schema.optional(UtcTimestamp),
  }),
  Schema.Struct({
    kind: Schema.Literal("disable"),
    threadId: Schema.optional(CodeThreadId),
    target: CodeProjectPullRequestSwitchTarget,
  }),
]);
export type CodeProjectPullRequestAutoFixCommand = typeof CodeProjectPullRequestAutoFixCommand.Type;

/** What a pull request is waiting on before the forge merges it. */
export const CodeProjectPullRequestMergeWait = Schema.Literals(["checks", "reviews", "conflicts"]);
export type CodeProjectPullRequestMergeWait = typeof CodeProjectPullRequestMergeWait.Type;

export const CodeProjectPullRequestMergeWhenReadyState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("off") }),
  Schema.Struct({
    status: Schema.Literal("on"),
    method: CodeProjectPullRequestMergeMethod,
    enabledAt: UtcTimestamp,
    /** Empty until the host has observed the pull request since it was turned on. */
    waitingOn: Schema.Array(CodeProjectPullRequestMergeWait).check(Schema.isMaxLength(3)),
  }),
  Schema.Struct({
    status: Schema.Literal("merged"),
    observedAt: UtcTimestamp,
  }),
  Schema.Struct({
    status: Schema.Literal("turned-off-by-forge"),
    observedAt: UtcTimestamp,
  }),
]);
export type CodeProjectPullRequestMergeWhenReadyState =
  typeof CodeProjectPullRequestMergeWhenReadyState.Type;

/** Why Auto-fix stopped on its own. */
export const CodeProjectPullRequestAutoFixStopReason = Schema.Literals([
  "attempt-limit",
  "feedback-limit",
  "needs-help",
  "ready",
  "merged",
  "closed",
  "thread-unavailable",
  "authority-lost",
]);
export type CodeProjectPullRequestAutoFixStopReason =
  typeof CodeProjectPullRequestAutoFixStopReason.Type;

/** Why Auto-fix is holding a wake back right now. Never journaled. */
export const CodeProjectPullRequestAutoFixPauseReason = Schema.Literals([
  "person-typing",
  "turn-active",
]);
export type CodeProjectPullRequestAutoFixPauseReason =
  typeof CodeProjectPullRequestAutoFixPauseReason.Type;

/** One failure Auto-fix watches for, by kind and a short opaque identity. */
export const CodeProjectPullRequestAutoFixFailure = Schema.Struct({
  kind: Schema.Literals(["check", "review-thread", "conflict", "behind", "feedback"]),
  /** Check name, review thread id, or `base` for a merge conflict. */
  key: boundedNonEmptyText(512),
});
export type CodeProjectPullRequestAutoFixFailure = typeof CodeProjectPullRequestAutoFixFailure.Type;

export const CodeProjectPullRequestAutoFixWakeResult = Schema.Literals([
  "started",
  "refused",
  "unmarked",
]);
export type CodeProjectPullRequestAutoFixWakeResult =
  typeof CodeProjectPullRequestAutoFixWakeResult.Type;

export const CodeProjectPullRequestAutoFixState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("off") }),
  Schema.Struct({
    status: Schema.Literal("on"),
    threadId: CodeThreadId,
    enabledAt: UtcTimestamp,
    babysit: Schema.optional(PullRequestBabysitRules),
    pausedFor: Schema.optional(CodeProjectPullRequestAutoFixPauseReason),
    lastWake: Schema.optional(
      Schema.Struct({
        at: UtcTimestamp,
        attempt: Schema.Int.check(
          Schema.isBetween({
            minimum: 1,
            maximum: MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_ATTEMPTS_SETTING,
          }),
        ),
        result: CodeProjectPullRequestAutoFixWakeResult,
        failures: Schema.Array(CodeProjectPullRequestAutoFixFailure).check(
          Schema.isMaxLength(MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_FAILURES),
        ),
      }),
    ),
  }),
  Schema.Struct({
    status: Schema.Literal("stopped"),
    threadId: CodeThreadId,
    reason: CodeProjectPullRequestAutoFixStopReason,
    babysit: Schema.optional(PullRequestBabysitRules),
    readyHeadSha: Schema.optional(boundedNonEmptyText(64)),
    stoppedAt: UtcTimestamp,
  }),
]);
export type CodeProjectPullRequestAutoFixState = typeof CodeProjectPullRequestAutoFixState.Type;

export const CodeProjectPullRequestSwitchesView = Schema.Struct({
  version: Schema.Literal(1),
  target: CodeProjectPullRequestSwitchTarget,
  mergeWhenReady: CodeProjectPullRequestMergeWhenReadyState,
  autoFix: CodeProjectPullRequestAutoFixState,
  /**
   * Auto-fix's attempts per failure as Settings has it now. Absent from a
   * host older than the setting, which means the former fixed three.
   */
  autoFixAttempts: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({
        minimum: 1,
        maximum: MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_ATTEMPTS_SETTING,
      }),
    ),
  ),
  generatedAt: UtcTimestamp,
});
export type CodeProjectPullRequestSwitchesView = typeof CodeProjectPullRequestSwitchesView.Type;

/**
 * The answer to a switch command. Refusals and an unsupported forge are
 * values, so the pane can say exactly why a switch did not move.
 */
export const CodeProjectPullRequestSwitchOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("applied"),
    alreadyActive: Schema.optional(Schema.Literal(true)),
    view: CodeProjectPullRequestSwitchesView,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literals([
      "not-authorized",
      "not-open",
      "stale",
      "thread-not-linked",
      "already-active",
      "method-not-allowed",
      "failed",
    ]),
  }),
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    reason: Schema.Literal("auto-merge-not-allowed"),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["disconnected", "unauthenticated", "unavailable"]),
  }),
  CodeOwnerMergeUnlockRefusal,
]);
export type CodeProjectPullRequestSwitchOutcome = typeof CodeProjectPullRequestSwitchOutcome.Type;

/**
 * A window saying its person is composing in a Code thread. Auto-fix holds
 * its wake back while this is recent, so it never talks over the person.
 */
export const CodeThreadComposerActivity = Schema.Struct({
  threadId: CodeThreadId,
});
export type CodeThreadComposerActivity = typeof CodeThreadComposerActivity.Type;

/** Pull requests one thread's waiting row and its details name. */
export const MAX_CODE_THREAD_PULL_REQUEST_WAITS = 32;

/**
 * One pull request a Code thread waits on between turns: the agent's own
 * watch, or Auto-fix or babysitting this thread repairs. Merge when ready is
 * the pull request's, so it is never a thread's wait.
 */
export const CodeThreadPullRequestWait = Schema.Struct({
  kind: Schema.Literals(["watch", "auto-fix", "babysit"]),
  target: CodeProjectPullRequestSwitchTarget,
  /** When it was turned on; a stop names it, so it never ends a later one. */
  since: UtcTimestamp,
  /** On, but reading nothing until a window vouches for it or the host reconnects. */
  paused: Schema.Boolean,
  /**
   * What holds a paused wait besides a window not yet vouching for it: GitHub
   * access is revoked, or the last pass could not read the pull request.
   */
  pausedBy: Schema.optional(Schema.Literals(["github-disconnected", "unreachable"])),
  /** Turns it has started, and the count that ends it. */
  wakes: Schema.optional(NonNegativeInt),
  wakeLimit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_CODE_PROJECT_PULL_REQUEST_WATCH_WAKES_SETTING }),
    ),
  ),
  endsAt: Schema.optional(UtcTimestamp),
});
export type CodeThreadPullRequestWait = typeof CodeThreadPullRequestWait.Type;

export const CodeThreadPullRequestWaits = Schema.Struct({
  threadId: CodeThreadId,
  waits: Schema.Array(CodeThreadPullRequestWait).check(
    Schema.isMaxLength(MAX_CODE_THREAD_PULL_REQUEST_WAITS),
  ),
});
export type CodeThreadPullRequestWaits = typeof CodeThreadPullRequestWaits.Type;

/** The person stops one of a thread's own waits. Babysitting stops as Auto-fix. */
export const StopCodeThreadPullRequestWait = Schema.Struct({
  kind: Schema.Literal("stop-code-thread-pull-request-wait"),
  threadId: CodeThreadId,
  wait: Schema.Literals(["watch", "auto-fix"]),
  target: CodeProjectPullRequestSwitchTarget,
  since: UtcTimestamp,
});
export type StopCodeThreadPullRequestWait = typeof StopCodeThreadPullRequestWait.Type;

export const StopCodeThreadPullRequestWaitResult = Schema.Struct({
  kind: Schema.Literal("code-thread-pull-request-wait-stopped"),
  /** False when that wait had already ended, or a later one took its place. */
  stopped: Schema.Boolean,
});
export type StopCodeThreadPullRequestWaitResult = typeof StopCodeThreadPullRequestWaitResult.Type;

export const decodeCodeThreadPullRequestWaits = Schema.decodeUnknownSync(
  CodeThreadPullRequestWaits,
  STRICT_DECODE_OPTIONS,
);
export const decodeStopCodeThreadPullRequestWait = Schema.decodeUnknownSync(
  StopCodeThreadPullRequestWait,
  STRICT_DECODE_OPTIONS,
);

export const CODE_PROJECT_PULL_REQUEST_MERGE_WHEN_READY_RECORDED =
  "code.project-pull-request-merge-when-ready-recorded@1";
export const CODE_PROJECT_PULL_REQUEST_AUTO_FIX_RECORDED =
  "code.project-pull-request-auto-fix-recorded@1";
export const CODE_PROJECT_PULL_REQUEST_WATCH_RECORDED =
  "code.project-pull-request-watch-recorded@1";
/** Every switch and watch event shares this aggregate type. */
export const CODE_PROJECT_PULL_REQUEST_SWITCHES_AGGREGATE = "code-project-pull-request-switches";

/**
 * One change to a pull request's Merge when ready switch. `enabled` and
 * `disabled` are the person's clicks from a local window; `merged` and
 * `turned-off-by-forge` are what the host later observed.
 */
export const CodeProjectPullRequestMergeWhenReadyRecorded = Schema.Struct({
  target: CodeProjectPullRequestSwitchTarget,
  change: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("enabled"),
      method: CodeProjectPullRequestMergeMethod,
      headSha: boundedNonEmptyText(64),
      /** Set when a paired phone or web client turned it on; absent for the local window. */
      caller: Schema.optional(Schema.Literal("remote-device")),
    }),
    Schema.Struct({ kind: Schema.Literal("disabled") }),
    Schema.Struct({ kind: Schema.Literal("merged") }),
    Schema.Struct({ kind: Schema.Literal("turned-off-by-forge") }),
  ]),
});
export type CodeProjectPullRequestMergeWhenReadyRecorded =
  typeof CodeProjectPullRequestMergeWhenReadyRecorded.Type;

/**
 * One change to a pull request's Auto-fix switch, or one wake it made. A wake
 * records which failures it carried, so the attempt count per failure is
 * rebuilt from the journal alone. Failure text never enters the journal.
 */
export const CodeProjectPullRequestAutoFixRecorded = Schema.Struct({
  target: CodeProjectPullRequestSwitchTarget,
  threadId: CodeThreadId,
  change: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("enabled"),
      babysit: Schema.optional(PullRequestBabysitRules),
    }),
    Schema.Struct({ kind: Schema.Literal("disabled") }),
    Schema.Struct({
      kind: Schema.Literal("woke"),
      /** The head the failures were observed on. */
      headSha: boundedNonEmptyText(64),
      failures: Schema.Array(CodeProjectPullRequestAutoFixFailure).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_FAILURES),
      ),
      attempt: Schema.Int.check(
        Schema.isBetween({
          minimum: 1,
          maximum: MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_ATTEMPTS_SETTING,
        }),
      ),
      result: CodeProjectPullRequestAutoFixWakeResult,
    }),
    Schema.Struct({
      kind: Schema.Literal("stopped"),
      reason: CodeProjectPullRequestAutoFixStopReason,
      readyHeadSha: Schema.optional(boundedNonEmptyText(64)),
    }),
  ]),
});
export type CodeProjectPullRequestAutoFixRecorded =
  typeof CodeProjectPullRequestAutoFixRecorded.Type;

/**
 * One thing that happened on a watched pull request, by kind and a short
 * opaque identity: the head SHA for settled checks and a conflict, the
 * decision for a review decision, and the forge's id for a review or comment.
 */
export const CodeProjectPullRequestWatchSignal = Schema.Struct({
  kind: Schema.Literals([
    "checks-passed",
    "checks-failed",
    "review-decision",
    "review",
    "comment",
    "conflict",
  ]),
  key: boundedNonEmptyText(512),
});
export type CodeProjectPullRequestWatchSignal = typeof CodeProjectPullRequestWatchSignal.Type;

/** Why a watch ended on its own. */
export const CodeProjectPullRequestWatchStopReason = Schema.Literals([
  "merged",
  "closed",
  "thread-unavailable",
  "authority-lost",
  "expired",
  "wake-limit",
]);
export type CodeProjectPullRequestWatchStopReason =
  typeof CodeProjectPullRequestWatchStopReason.Type;

/**
 * One change to a thread's watch on its own pull request, or one wake it
 * made. `enabled` and `disabled` are the thread's agent (turning it on took
 * the person's approval of that act); `woke` and `stopped` are the host. The
 * baseline is what was already true when the watch began, so it never wakes
 * for that; a wake records its signals, so what already woke the thread is
 * rebuilt from the journal alone. Forge text never enters the journal.
 */
export const CodeProjectPullRequestWatchRecorded = Schema.Struct({
  target: CodeProjectPullRequestSwitchTarget,
  threadId: CodeThreadId,
  change: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("enabled"),
      baseline: Schema.Array(CodeProjectPullRequestWatchSignal).check(
        Schema.isMaxLength(MAX_CODE_PROJECT_PULL_REQUEST_WATCH_SIGNALS),
      ),
    }),
    Schema.Struct({ kind: Schema.Literal("disabled") }),
    Schema.Struct({
      kind: Schema.Literal("woke"),
      /** The head the signals were observed on. */
      headSha: boundedNonEmptyText(64),
      signals: Schema.Array(CodeProjectPullRequestWatchSignal).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(MAX_CODE_PROJECT_PULL_REQUEST_WATCH_SIGNALS),
      ),
      wake: Schema.Int.check(
        Schema.isBetween({
          minimum: 1,
          maximum: MAX_CODE_PROJECT_PULL_REQUEST_WATCH_WAKES_SETTING,
        }),
      ),
      result: CodeProjectPullRequestAutoFixWakeResult,
    }),
    Schema.Struct({
      kind: Schema.Literal("stopped"),
      reason: CodeProjectPullRequestWatchStopReason,
    }),
  ]),
});
export type CodeProjectPullRequestWatchRecorded = typeof CodeProjectPullRequestWatchRecorded.Type;

export const decodeCodeProjectPullRequestSwitchTarget = Schema.decodeUnknownSync(
  CodeProjectPullRequestSwitchTarget,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestMergeWhenReadyCommand = Schema.decodeUnknownSync(
  CodeProjectPullRequestMergeWhenReadyCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestAutoFixCommand = Schema.decodeUnknownSync(
  CodeProjectPullRequestAutoFixCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestSwitchesView = Schema.decodeUnknownSync(
  CodeProjectPullRequestSwitchesView,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestSwitchOutcome = Schema.decodeUnknownSync(
  CodeProjectPullRequestSwitchOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeThreadComposerActivity = Schema.decodeUnknownSync(
  CodeThreadComposerActivity,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestMergeWhenReadyRecorded = Schema.decodeUnknownSync(
  CodeProjectPullRequestMergeWhenReadyRecorded,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestAutoFixRecorded = Schema.decodeUnknownSync(
  CodeProjectPullRequestAutoFixRecorded,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestWatchRecorded = Schema.decodeUnknownSync(
  CodeProjectPullRequestWatchRecorded,
  STRICT_DECODE_OPTIONS,
);
