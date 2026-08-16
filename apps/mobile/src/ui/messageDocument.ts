/**
 * Mobile re-exports Distilled message-document helpers from domain so
 * web/desktop can share the same resolver later.
 */
export {
  parseChatMessageBody as parseMessageDocument,
  parseMarkdownBlocks,
  resolveChatMessageParts,
  type MarkdownBlock,
} from "@octant/domain/chat-message-parts";
export type { ChatMessagePart as MessageDocPart } from "@octant/contracts";
