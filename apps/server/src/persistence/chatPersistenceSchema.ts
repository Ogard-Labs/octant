import type { ChatThreadId } from "@octant/contracts";

export const CHAT_PROJECTION_SCHEMA_VERSION = 1;
export const CHAT_SETTINGS_KEY = "chat-settings";

export type ChatContentRole = "user" | "assistant" | "research" | "snippet";
export type ChatPurgeState = "pending" | "completed";

export interface ChatSettingsProjectionRow {
  readonly projection_key: string;
  readonly schema_version: number;
  readonly settings_json: string;
  readonly aggregate_version: number;
}

export interface ChatThreadProjectionRow {
  readonly thread_id: string;
  readonly project_id: string | null;
  readonly lifecycle: "active" | "archived" | "deleting" | "deleted";
  readonly schema_version: number;
  readonly thread_json: string;
  readonly aggregate_version: number;
  readonly updated_at: string;
  readonly last_sequence: number;
}

export interface ChatTurnProjectionRow {
  readonly turn_id: string;
  readonly thread_id: string;
  readonly sequence: number;
  readonly schema_version: number;
  readonly turn_json: string;
  readonly aggregate_version: number;
  readonly created_at: string;
  readonly last_sequence: number;
}

export interface ChatAttemptProjectionRow {
  readonly attempt_id: string;
  readonly turn_id: string;
  readonly thread_id: string;
  readonly schema_version: number;
  readonly attempt_json: string;
  readonly aggregate_version: number;
  readonly last_sequence: number;
}

export interface ChatTurnRouteProjectionRow {
  readonly turn_id: string;
  readonly thread_id: string;
  readonly schema_version: number;
  readonly decision_json: string;
  readonly aggregate_version: number;
  readonly decided_at: string;
  readonly last_sequence: number;
}

export interface ChatContentStoreRow {
  readonly content_id: string;
  readonly thread_id: string;
  readonly content_role: ChatContentRole;
  readonly body_text: string;
  readonly digest: string;
  readonly byte_length: number;
}

export interface ChatAttachmentProjectionRow {
  readonly attachment_id: string;
  readonly thread_id: string;
  readonly turn_id: string | null;
  readonly schema_version: number;
  readonly attachment_json: string;
  readonly aggregate_version: number;
  readonly last_sequence: number;
}

export interface ChatCitationProjectionRow {
  readonly citation_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly attempt_id: string;
  readonly schema_version: number;
  readonly citation_json: string;
  readonly aggregate_version: number;
  readonly last_sequence: number;
}

export interface ChatSearchProjectionRow {
  readonly thread_id: string;
  readonly schema_version: number;
  readonly search_text: string;
  readonly updated_at: string;
  readonly last_sequence: number;
}

export interface ThreadWorkItemProjectionRow {
  readonly thread_id: string;
  readonly item_id: string;
  readonly schema_version: number;
  readonly work_item_json: string;
  readonly aggregate_version: number;
  readonly last_sequence: number;
}

export interface ThreadFollowUpProjectionRow {
  readonly thread_id: string;
  readonly schema_version: number;
  readonly follow_up_json: string;
  readonly state: "open" | "completed";
  readonly aggregate_version: number;
  readonly last_sequence: number;
}

export interface ChatPurgeProjectionRow {
  readonly thread_id: string;
  readonly state: ChatPurgeState;
  readonly requested_at: string;
  readonly completed_at: string | null;
  readonly last_sequence: number;
}

export interface ProjectedChatContent {
  readonly contentId: string;
  readonly threadId: ChatThreadId;
  readonly role: ChatContentRole;
  readonly body: string;
  readonly digest: string;
  readonly byteLength: number;
}

export interface PendingChatPurge {
  readonly threadId: ChatThreadId;
  readonly requestedAt: string;
  readonly lastSequence: number;
}

export function assertChatProjectionSchema(schemaVersion: number): void {
  if (schemaVersion !== CHAT_PROJECTION_SCHEMA_VERSION) {
    throw new Error("unsupported Chat projection schema version");
  }
}
