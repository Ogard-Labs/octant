import { THREAD_RETENTION_EVENT_NAMES } from "@octant/contracts";

/**
 * What an import from Octant does with each part of Octant's store
 * (docs/design/nightly-app.md#importing-from-octant). Projection tables are
 * not listed: the merged store rebuilds every projection from its journal.
 * Every other table must be named here; the schema sweep in
 * octantImport.test.ts fails for one that is not.
 */

/**
 * Journal aggregates that belong to Octant's host and never come over: its
 * identity and private listener, paired devices and push registrations, hub
 * and artifact sync membership, desktop leases, terminal sessions, provider
 * cloud jobs it started, and the history of threads moved between hosts.
 */
export const EXCLUDED_AGGREGATE_TYPES: ReadonlySet<string> = new Set([
  "remote-host",
  "remote-device",
  "remote-device-alerts",
  "remote-port-forward",
  "remote-push-delivery",
  "remote-push-registration",
  "remote-server-grant",
  "hub-membership",
  "hub-delegation",
  "replica-membership",
  "replica-store-settings",
  "desktop-lease",
  "thread-terminal-session",
  "provider-cloud-session",
  "thread-move",
  "thread-moved-history",
  // Public share links, records as well as secrets, so the two hosts never
  // both control one link. The person's Public links setting still comes over.
  "canvas-public-share",
  "canvas-public-share-revocation",
]);

/**
 * Events that record what Octant's host did to files outside its data
 * folder. A Canvas mirror receipt names the absolute files Octant wrote, and
 * purging a Canvas deletes the files its receipts name; in Nightly that would
 * unlink Octant's mirrored files. Only the mirror setting comes over.
 */
const EXCLUDED_EVENT_NAMES: ReadonlySet<string> = new Set([
  "artifact.mirror-written@1",
  "artifact.mirror-reimported@1",
]);

/** Every `remote.*` event is the paired-device and host-identity family. */
export function isExcludedOctantEvent(aggregateType: string, eventName: string): boolean {
  return (
    EXCLUDED_AGGREGATE_TYPES.has(aggregateType) ||
    EXCLUDED_EVENT_NAMES.has(eventName) ||
    eventName.startsWith("remote.")
  );
}

/**
 * Deleting a thread in either app never deletes it in the other. A purge
 * leaves Octant's journal without the thread's events, so its record names a
 * thread Nightly may still hold; it never comes over.
 */
export const NEVER_COPIED_EVENT_NAMES: ReadonlySet<string> = new Set([
  THREAD_RETENTION_EVENT_NAMES.threadPurged,
]);

/**
 * Events that delete the record their stream holds. Deleting something in
 * either app never deletes it in the other, so when Nightly already holds the
 * stream, Octant's events for it stay behind and the record is listed as
 * kept. Removals of an item inside a stream (a Canvas comment, a Project's
 * extra folder, an entry of a settings list) are edits and come over.
 */
export const RECORD_REMOVAL_EVENT_NAMES: ReadonlySet<string> = new Set([
  "provider.instance-removed@1",
  "agent.profile-removed@1",
  "agent-access.key-removed@1",
  "benchmark-suite-deleted@1",
  "browser.extension-removed@1",
  "browser.flow-deleted@1",
  "code.checkout-removed@1",
  "todo.deleted@1",
]);

/** A Chat deletion Octant made is dropped for a thread Nightly already holds. */
export const THREAD_DELETION_EVENT_NAMES: ReadonlySet<string> = new Set([
  "chat.deletion-requested@1",
  "chat.deleted@1",
]);

/**
 * Aggregates whose payloads carry no copy of their own version, so their
 * events may land at a Nightly version other than the one Octant gave them.
 * Startup compaction renumbers `code-checkout` streams in each store on its
 * own; and a dropped purge record shifts the `thread-retention` stream.
 * Every other stream is appended only where Nightly's head is exactly where
 * Octant's next event expects it: Chat threads, queues and routines store
 * their version in the payload, and a shifted copy fails the rebuild or every
 * later command's concurrency check.
 */
export const RENUMBERABLE_AGGREGATE_TYPES: ReadonlySet<string> = new Set([
  "code-checkout",
  "thread-retention",
]);

/**
 * The settings singletons whose stream Octant's replaces on the first
 * import, as the confirmation says. A stream both stores hold that is not
 * named here keeps Nightly's and is listed; `thread-retention` is not named
 * because it also holds Nightly's purge records, which must survive.
 */
export const REPLACED_SETTINGS_AGGREGATE_TYPES: ReadonlySet<string> = new Set([
  // Shell: modes shown, sidebar and window chrome.
  "shell-settings",
  // Appearance: theme and colors.
  "theme-settings",
  // Default Chat model, research and personality.
  "chat-settings",
  // Default Code access, models and review choices.
  "code-settings",
  // Default Work access and models.
  "work-settings",
  // Web search provider choice.
  "web-search-settings",
  // Default provider and model per mode.
  "provider-defaults",
  // Child agent run defaults.
  "agent-run-settings",
  // Environment names and colors shown in the window.
  "environment-presentation",
  // Tools the person blocked.
  "blocked-tools",
  // Files agents may not change.
  "protected-files",
  // Whether tool servers run plan-only.
  "mcp-plan-read-only",
  // Networks the person marked safe.
  "safe-networks",
  // The person's own instructions to every agent.
  "person-instructions",
  // Instructions for coordinating threads.
  "orchestration-instructions",
  // Memory on or off and what it keeps.
  "person-memory-settings",
]);

/**
 * Streams each host writes about the folders it sees itself: Code's
 * bootstrap and restart reconciliation journal an observation of every
 * checkout on each start, and a checkout's id derives from its folder, so
 * both hosts write to the same stream without anyone doing anything. When
 * both did, Nightly's own observation stands and is not reported as a change
 * the person made.
 */
export const SELF_OBSERVED_AGGREGATE_TYPES: ReadonlySet<string> = new Set(["code-checkout"]);

/**
 * Out-of-journal content that projections do not rebuild. Rows come over add
 * only for the threads and aggregates the import brings; a row Nightly
 * already has keeps Nightly's value.
 */
export const COPIED_CONTENT_TABLES = [
  "chat_content_store",
  "thread_tool_call_record_store",
  "context_summary_content_store",
  "agent_run_content_store",
  "code_evidence_content_store",
] as const;

/**
 * Markers a migration wrote about usage records it found, read by usage
 * totals for those records. Inert for any record that is not there.
 */
export const COPIED_MARKER_TABLES = [
  "usage_reasoning_outside_output",
  "usage_unreported_guarded_turn",
] as const;

/** The journal itself and the bookkeeping the merge and rebuild own. */
export const JOURNAL_TABLES = [
  "event_journal",
  "sqlite_sequence",
  "schema_migrations",
  "projection_checkpoints",
  "event_quarantine",
] as const;

/**
 * Nightly's own state that never takes Octant's rows: host-bound records,
 * restart continuations and coordinator counts of Octant's running work
 * (in-flight work arrives settled), queued message bodies (queued messages
 * arrive cancelled), and one-shot host bookkeeping.
 */
export const EXCLUDED_TABLES = [
  "host_identity_projection",
  "binding_receipt_store",
  "agent_access_credential_store",
  "remote_auth_challenge_store",
  "remote_request_nonce_store",
  "remote_session_store",
  "remote_clock_guard",
  "local_authority_clock_guard",
  "code_restart_continuation_store",
  "coordinator_count_store",
  "coordinator_host_turn_store",
  "thread_message_queue_content",
  "journal_verification_watermark",
  "pending_session_sweep",
  "usage_audit_log",
] as const;

/** The full-text index triggers keep in step with `thread_search_document`. */
export const TRIGGER_MAINTAINED_TABLES = [
  "thread_search_fts",
  "thread_search_fts_config",
  "thread_search_fts_data",
  "thread_search_fts_docsize",
  "thread_search_fts_idx",
] as const;
