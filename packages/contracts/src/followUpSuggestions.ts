/**
 * Follow-up suggestions: the next tasks a reply offers to start, on any
 * provider in any mode.
 *
 * The model ends a reply with one fenced block in the language below; the
 * host reads it, journals the set on the thread, and every surface offers the
 * suggestions as chips. A suggestion creates nothing by itself: a person
 * previews exactly what it would create and confirms, and the thread lands
 * through the mode's ordinary creation command. The suggestion shapes are the
 * ones the native harness introduced, so a harness session and a plain thread
 * describe the same suggestion the same way.
 */

import { Schema } from "effect";
import { OctantMode } from "./modes";
import {
  MAX_NATIVE_HARNESS_FOLLOW_UPS,
  NativeHarnessFollowUpCreation,
  NativeHarnessFollowUpId,
  NativeHarnessFollowUpSet,
} from "./nativeHarness";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The fence language a reply's suggestions arrive in; a reply without it suggests nothing. */
export const FOLLOW_UP_BLOCK_LANGUAGE = "octant-follow-ups";

/** The model that suggested a set; a new thread from it starts on the same model. */
export const FollowUpSuggestedBy = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
}).annotations(strict);
export type FollowUpSuggestedBy = typeof FollowUpSuggestedBy.Type;

/**
 * The latest reply's suggestions on one thread. A later reply without a block
 * replaces them with an empty set, so an old offer never outlives the turn
 * that made it.
 */
export const ThreadFollowUpSuggestions = Schema.Struct({
  threadId: Schema.UUID,
  mode: OctantMode,
  projectId: Schema.optional(ProjectId),
  suggestedBy: FollowUpSuggestedBy,
  followUps: NativeHarnessFollowUpSet,
  activatedFollowUpIds: Schema.Array(NativeHarnessFollowUpId).pipe(
    Schema.maxItems(MAX_NATIVE_HARNESS_FOLLOW_UPS),
  ),
}).annotations(strict);
export type ThreadFollowUpSuggestions = typeof ThreadFollowUpSuggestions.Type;

export const ThreadFollowUpsSuggested = Schema.Struct({
  threadId: Schema.UUID,
  mode: OctantMode,
  projectId: Schema.optional(ProjectId),
  suggestedBy: FollowUpSuggestedBy,
  followUps: NativeHarnessFollowUpSet,
}).annotations(strict);
export type ThreadFollowUpsSuggested = typeof ThreadFollowUpsSuggested.Type;

export const ThreadFollowUpActivated = Schema.Struct({
  suggestionId: NativeHarnessFollowUpId,
  created: NativeHarnessFollowUpCreation,
}).annotations(strict);
export type ThreadFollowUpActivated = typeof ThreadFollowUpActivated.Type;

export const THREAD_FOLLOW_UP_SUGGESTIONS_AGGREGATE_TYPE = "thread-follow-up-suggestions";
export const THREAD_FOLLOW_UP_SUGGESTION_EVENT_NAMES = {
  suggested: "thread-follow-ups-suggested@1",
  activated: "thread-follow-up-activated@1",
} as const;

export const decodeThreadFollowUpSuggestions = Schema.decodeUnknownSync(ThreadFollowUpSuggestions);
export const decodeThreadFollowUpsSuggested = Schema.decodeUnknownSync(ThreadFollowUpsSuggested);
