/**
 * Octant's own limits that protect no hard line, each a setting whose default
 * is the value it had as a fixed limit (docs/architecture.md, Security and
 * authority: Octant's own limits become settings). Each top stays finite: the
 * journal, spend ceilings and the person's Stop bound what an agent does, and
 * a finite top keeps a mistyped number from meaning "without end".
 *
 * They live here, importing nothing, because Shell settings and each owner
 * (pull requests, coordinators, wake-ups) read them, and the owners' modules
 * import modules that import Shell settings.
 */

/** How many wake-ups one thread may have waiting, missed ones included. */
export const DEFAULT_THREAD_WAKEUPS_WAITING = 8;
export const MAX_THREAD_WAKEUPS_WAITING_SETTING = 64;

/** How many coordinators a Code Project may hold, the planner included. */
export const MAX_COORDINATORS_PER_PROJECT = 4;
/** The most a person may set; each coordinator is a person's thread and keeps a finite top. */
export const MAX_COORDINATORS_PER_PROJECT_SETTING = 32;

/**
 * A coordinator's hourly and round bounds when the person set none
 * (docs/design/coordinator-threads.md, Bounds and Talking to workers), and
 * every other thread's message-wake bounds unless Settings says otherwise.
 */
export const DEFAULT_COORDINATOR_WAKES_PER_HOUR = 30;
export const DEFAULT_COORDINATOR_ROUNDS = 10;
/**
 * The most a person may set. These bounds are what stops two agents waking
 * each other without end, so each keeps a finite top.
 */
export const MAX_COORDINATOR_WAKES_PER_HOUR = 600;
export const MAX_COORDINATOR_ROUNDS = 100;

/**
 * Automatic attempts Auto-fix makes on one distinct failure before it stops
 * and hands the pull request back to the person. The setting's top bounds
 * what a journaled wake may record.
 */
export const CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS = 3;
export const MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_ATTEMPTS_SETTING = 20;
/**
 * Started wakes one watch makes before it stops, so a pull request that keeps
 * changing hands the thread back to the person instead of waking it forever.
 */
export const CODE_PROJECT_PULL_REQUEST_WATCH_MAX_WAKES = 10;
export const MAX_CODE_PROJECT_PULL_REQUEST_WATCH_WAKES_SETTING = 100;
/**
 * How long a watch lasts after it is turned on. Three days covers a review
 * round across a weekend; a watch nobody renews then ends on its own.
 */
export const CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_DAYS = 3;
export const MAX_CODE_PROJECT_PULL_REQUEST_WATCH_DAYS_SETTING = 30;

/** Thread messages one turn may send to other threads under Strict. */
export const DEFAULT_THREAD_MESSAGES_PER_TURN = 3;
export const MAX_THREAD_MESSAGES_PER_TURN_SETTING = 20;

/** Sibling-thread `read` calls one turn may make under Strict. */
export const DEFAULT_SIBLING_THREAD_READS_PER_TURN = 8;
export const MAX_SIBLING_THREAD_READS_PER_TURN_SETTING = 64;

/** Sibling-thread `wait` calls one turn may make under Strict. */
export const DEFAULT_SIBLING_THREAD_WAITS_PER_TURN = 4;
export const MAX_SIBLING_THREAD_WAITS_PER_TURN_SETTING = 32;

/** A child run's `wait`, in seconds. */
export const DEFAULT_CHILD_RUN_WAIT_LIMIT_SECONDS = 120;
export const MAX_CHILD_RUN_WAIT_LIMIT_SECONDS_SETTING = 3_600;
