import {
  decodeCodeCheckoutId,
  decodeCodeCheckoutIdentity,
  decodeCodeBoardQuery,
  decodeCodeBoardView,
  decodeCodeProjectPullRequestQuery,
  decodeCodeProjectPullRequestRefreshCommand,
  decodeCodeProjectPullRequestView,
  decodeCodeProjectPullRequestDetailQuery,
  decodeCodeProjectPullRequestDetailRefreshCommand,
  decodeCodeProjectPullRequestDetailView,
  decodeCodeCommand,
  decodeCodeCommandResult,
  decodeCodeEvidenceContentId,
  decodeCodeEvidenceReference,
  decodeCodeEvidenceBatchRequest,
  decodeCodeEvidenceBatchResponse,
  decodeCodeEventFrame,
  decodeCodeFailure,
  decodeCodeFollowUpCommand,
  decodeCodePlannerCommand,
  decodeCodePlannerCommandOutcome,
  decodeCodePlannerProposalCommand,
  decodeCodePlannerProposalOutcome,
  decodeCodePlannerView,
  decodeCodeThreadFollowUpUpdated,
  decodeCodeThreadFollowUpView,
  decodeProjectId,
  decodeCodeOperationCommand,
  decodeCodeConversationPage,
  decodeCodeOperationStreamFrame,
  decodeCodeOperationId,
  decodeCodeOperationResult,
  decodeCodeTerminalInspection,
  decodeCodeTerminalInspectionRequest,
  decodeCodeFileOpenResultEnvelope,
  decodeCodeFileSaveResultEnvelope,
  decodeCodeRelativePath,
  decodeCodeRepositoryTestListing,
  decodeCodeSettings,
  decodeCodeThread,
  decodeCodeNavigation,
  decodeCodeNavigationRuntime,
  decodeCodeThreadActivity,
  decodeCodeAttachmentId,
  decodeCodeAttachmentMediaType,
  decodeCodeAttachmentReference,
  decodeCodeThreadId,
  type CodeAttachmentId,
  type CodeAttachmentMediaType,
  type CodeAttachmentReference,
  type CodeBoardQuery,
  type CodeBoardView,
  type CodeProjectPullRequestQuery,
  type CodeProjectPullRequestRefreshCommand,
  type CodeProjectPullRequestView,
  type CodeProjectPullRequestDetailQuery,
  type CodeProjectPullRequestDetailRefreshCommand,
  type CodeProjectPullRequestDetailView,
  type CodeBootstrap,
  type CodeNavigation,
  type CodeCheckoutId,
  type CodeCommand,
  type CodeCommandResult,
  type CodeEvidenceContentId,
  type CodeEvidenceReference,
  type CodeEvidenceBatchRequest,
  type CodeEvidenceBatchResponse,
  type CodeEventFrame,
  type CodeFailure,
  type CodeFollowUpCommand,
  type CodePlannerCommand,
  type CodePlannerCommandOutcome,
  type CodePlannerProposalCommand,
  type CodePlannerProposalOutcome,
  type CodePlannerView,
  type CodeThreadFollowUpUpdated,
  type CodeThreadFollowUpView,
  type ProjectId,
  type CodeOperationCommand,
  type CodeConversationPage,
  type CodeOperationStreamFrame,
  type CodeOperationId,
  type CodeOperationResult,
  type CodeTerminalInspection,
  type CodeTerminalInspectionRequest,
  type CodeFileOpenPublicResult,
  type CodeFileSavePublicResult,
  type CodeRelativePath,
  type CodeRepositoryTestListing,
  type CodeThreadId,
  type CodeThreadView,
  MAX_CODE_OPERATION_EVIDENCE_BYTES,
  MAX_CODE_ATTACHMENT_BYTES,
  MAX_CODE_OPERATION_TEXT_BYTES,
  MAX_CODE_CONVERSATION_PAGE_SIZE,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

/** The attachment route, addressed by thread and attachment. */
function attachmentUrl(baseUrl: string, threadId: string, attachmentId: string): URL {
  const url = new URL("/api/code/attachments", baseUrl);
  url.searchParams.set("thread", String(threadId));
  url.searchParams.set("attachment", String(attachmentId));
  return url;
}

export const MAX_CODE_NDJSON_LINE_BYTES = 1_048_576;
export const MAX_CODE_REPLAY_FRAMES = 100;
export const MAX_CODE_FILE_SAVE_BYTES = 5 * 1024 * 1024;

export interface CodeClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface CodeFileIdentity {
  readonly device: string;
  readonly inode: string;
}

export type CodeFileSaveResult = CodeFileSavePublicResult;

export type CodeFileOpenResult = CodeFileOpenPublicResult;

export interface CodeFileSave {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly path: CodeRelativePath;
  readonly expectedIdentity: CodeFileIdentity;
  readonly expectedDigest: string;
  readonly text: string;
}

export interface CodeClient {
  bootstrap(): Promise<CodeBootstrap>;
  navigation(): Promise<CodeNavigation>;
  thread(threadId: CodeThreadId, signal?: AbortSignal): Promise<CodeThreadView>;
  execute(command: CodeCommand, signal?: AbortSignal): Promise<CodeCommandResult>;
  executeOperation(command: CodeOperationCommand): Promise<CodeOperationResult>;
  inspectTerminal(request: CodeTerminalInspectionRequest): Promise<CodeTerminalInspection>;
  conversation(
    threadId: CodeThreadId,
    afterCursor: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<CodeConversationPage>;
  queryBoard(query: CodeBoardQuery): Promise<CodeBoardView>;
  queryProjectPullRequests(query: CodeProjectPullRequestQuery): Promise<CodeProjectPullRequestView>;
  refreshProjectPullRequests(
    command: CodeProjectPullRequestRefreshCommand,
  ): Promise<CodeProjectPullRequestView>;
  queryProjectPullRequestDetail(
    query: CodeProjectPullRequestDetailQuery,
  ): Promise<CodeProjectPullRequestDetailView>;
  refreshProjectPullRequestDetail(
    command: CodeProjectPullRequestDetailRefreshCommand,
  ): Promise<CodeProjectPullRequestDetailView>;
  readFollowUp(threadId: CodeThreadId): Promise<CodeThreadFollowUpView>;
  executeFollowUp(command: CodeFollowUpCommand): Promise<CodeThreadFollowUpUpdated>;
  /**
   * A Code Project's planner designation and its pending work proposals.
   *
   * Optional like `listTests`: the planner is a capability of the surface
   * rather than of every `CodeClient` composite the app builds. A caller
   * without it renders no planner state rather than inventing any.
   */
  readPlanner?(projectId: ProjectId): Promise<CodePlannerView>;
  /** Designate or undesignate the Project's planner thread; refusals are values. */
  executePlanner?(command: CodePlannerCommand): Promise<CodePlannerCommandOutcome>;
  /** Confirm (creating through the ordinary path) or decline one proposal. */
  executePlannerProposal?(command: CodePlannerProposalCommand): Promise<CodePlannerProposalOutcome>;
  putEvidence(threadId: CodeThreadId, text: string): Promise<CodeEvidenceReference>;
  /**
   * Hand the host one image for a thread's next turn. The host answers with
   * the reference a `start-provider-turn` names by id; nothing about the
   * bytes is decided here.
   */
  putAttachment(input: {
    readonly threadId: CodeThreadId;
    readonly attachmentId: CodeAttachmentId;
    readonly displayName: string;
    readonly mediaType: CodeAttachmentMediaType;
    readonly bytes: Uint8Array;
  }): Promise<CodeAttachmentReference>;
  /** Drop a staged image the composer no longer carries. */
  discardAttachment(threadId: CodeThreadId, attachmentId: CodeAttachmentId): Promise<void>;
  /** The bytes of an image a turn sent, verified against its journalled digest. */
  attachment(
    threadId: CodeThreadId,
    reference: CodeAttachmentReference,
  ): Promise<{ readonly bytes: Uint8Array; readonly mediaType: CodeAttachmentMediaType }>;
  content(contentId: CodeEvidenceContentId): Promise<Uint8Array>;
  operationContent(
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    contentId: CodeEvidenceContentId,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  operationContents?(
    input: CodeEvidenceBatchRequest,
    signal?: AbortSignal,
  ): Promise<CodeEvidenceBatchResponse>;
  save(input: CodeFileSave): Promise<CodeFileSaveResult>;
  /**
   * Open a confined file for the editor surface. The host resolves the root
   * and answers with the strict open envelope; the result's content reference
   * is fetched separately through `content`.
   */
  openFile(
    threadId: CodeThreadId,
    checkoutId: CodeCheckoutId,
    relativePath: CodeRelativePath,
  ): Promise<CodeFileOpenResult>;
  /**
   * The repository tests the host discovered for a thread's checkout.
   *
   * Optional because it is a capability of the surface rather than of every
   * `CodeClient` composite the app builds: a caller that does not have it
   * renders no test definitions rather than inventing any.
   */
  listTests?(
    threadId: CodeThreadId,
    checkoutId: CodeCheckoutId,
  ): Promise<CodeRepositoryTestListing>;
  subscribe(
    threadId: CodeThreadId,
    afterSequence: number,
    signal: AbortSignal,
  ): AsyncIterable<CodeEventFrame>;
  subscribeOperation(
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    afterCursor: number,
    signal: AbortSignal,
  ): AsyncIterable<CodeOperationStreamFrame>;
}

export class CodeClientFailure extends Error {
  readonly category: CodeFailure["category"];

  constructor(failure: CodeFailure) {
    super(failure.message);
    this.name = "CodeClientFailure";
    this.category = failure.category;
  }
}

export class CodeClientSnapshotRequiredError extends Error {
  readonly code = "snapshot-required";
  readonly reload = true;
  readonly threadId: CodeThreadId;
  readonly afterSequence: number;
  readonly receivedSequence: number;

  constructor(threadId: CodeThreadId, afterSequence: number, receivedSequence: number) {
    super("Code event replay has a sequence gap; reload the thread snapshot.");
    this.name = "CodeClientSnapshotRequiredError";
    this.threadId = threadId;
    this.afterSequence = afterSequence;
    this.receivedSequence = receivedSequence;
  }
}

export function createCodeClient(options: CodeClientOptions): CodeClient {
  const fetch = bindFetchPort(options.fetch);
  validateLoopbackBaseUrl(options.baseUrl);
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    bootstrap() {
      return request(
        fetch,
        new URL("/api/code/bootstrap", options.baseUrl).toString(),
        { method: "GET", headers },
        decodeBootstrap,
      );
    },
    navigation() {
      return request(
        fetch,
        new URL("/api/code/navigation", options.baseUrl).toString(),
        { method: "GET", headers },
        decodeCodeNavigation,
      );
    },
    thread(threadId, signal) {
      return request(
        fetch,
        new URL(`/api/code/threads/${encodeURIComponent(threadId)}`, options.baseUrl).toString(),
        { method: "GET", headers, ...(signal === undefined ? {} : { signal }) },
        decodeThreadView,
      );
    },
    async execute(command, signal) {
      let validated: CodeCommand;
      try {
        validated = decodeCodeCommand(command);
      } catch {
        throw invalidCommand();
      }
      return request(
        fetch,
        new URL("/api/code/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
          ...(signal === undefined ? {} : { signal }),
        },
        decodeCodeCommandResult,
      );
    },
    async executeOperation(command) {
      let validated: CodeOperationCommand;
      try {
        validated = decodeCodeOperationCommand(command);
      } catch {
        throw invalidCommand();
      }
      return request(
        fetch,
        new URL("/api/code/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        (value) => {
          const result = decodeCodeOperationResult(value);
          if (result.operationId !== validated.operationId) throw new Error("operation mismatch");
          return result;
        },
      );
    },
    async inspectTerminal(input) {
      let validated: CodeTerminalInspectionRequest;
      try {
        validated = decodeCodeTerminalInspectionRequest(input);
      } catch {
        throw invalidCommand();
      }
      return request(
        fetch,
        new URL("/api/code/terminals/inspect", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeCodeTerminalInspection,
      );
    },
    async queryBoard(query) {
      let validated: CodeBoardQuery;
      try {
        validated = decodeCodeBoardQuery(query);
      } catch {
        throw invalidBoardQuery();
      }
      return request(
        fetch,
        new URL("/api/code/board", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeCodeBoardView,
      );
    },
    async queryProjectPullRequests(query) {
      let validated: CodeProjectPullRequestQuery;
      try {
        validated = decodeCodeProjectPullRequestQuery(query);
      } catch {
        throw invalidProjectPullRequestQuery();
      }
      return request(
        fetch,
        new URL("/api/code/project-pull-requests", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeCodeProjectPullRequestView,
      );
    },
    async refreshProjectPullRequests(command) {
      let validated: CodeProjectPullRequestRefreshCommand;
      try {
        validated = decodeCodeProjectPullRequestRefreshCommand(command);
      } catch {
        throw invalidProjectPullRequestRefresh();
      }
      return request(
        fetch,
        new URL("/api/code/project-pull-requests/refresh", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeCodeProjectPullRequestView,
      );
    },
    async queryProjectPullRequestDetail(query) {
      let validated: CodeProjectPullRequestDetailQuery;
      try {
        validated = decodeCodeProjectPullRequestDetailQuery(query);
      } catch {
        throw invalidProjectPullRequestDetailQuery();
      }
      return request(
        fetch,
        new URL("/api/code/project-pull-requests/detail", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeCodeProjectPullRequestDetailView,
      );
    },
    async refreshProjectPullRequestDetail(command) {
      let validated: CodeProjectPullRequestDetailRefreshCommand;
      try {
        validated = decodeCodeProjectPullRequestDetailRefreshCommand(command);
      } catch {
        throw invalidProjectPullRequestDetailRefresh();
      }
      return request(
        fetch,
        new URL("/api/code/project-pull-requests/detail/refresh", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeCodeProjectPullRequestDetailView,
      );
    },
    readFollowUp(threadId) {
      try {
        decodeCodeThreadId(threadId);
      } catch {
        throw invalidCommand();
      }
      return request(
        fetch,
        new URL(
          `/api/code/threads/${encodeURIComponent(threadId)}/follow-up`,
          options.baseUrl,
        ).toString(),
        { method: "GET", headers },
        decodeCodeThreadFollowUpView,
      );
    },
    async executeFollowUp(command) {
      let validated: CodeFollowUpCommand;
      try {
        validated = decodeCodeFollowUpCommand(command);
      } catch {
        throw invalidCommand();
      }
      return request(
        fetch,
        new URL(
          `/api/code/threads/${encodeURIComponent(validated.threadId)}/follow-up`,
          options.baseUrl,
        ).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeCodeThreadFollowUpUpdated,
      );
    },
    readPlanner(projectId) {
      let validated: ProjectId;
      try {
        validated = decodeProjectId(projectId);
      } catch {
        throw invalidCommand();
      }
      return request(
        fetch,
        new URL(
          `/api/code/planner/${encodeURIComponent(String(validated))}`,
          options.baseUrl,
        ).toString(),
        { method: "GET", headers },
        decodeCodePlannerView,
      );
    },
    async executePlanner(command) {
      let validated: CodePlannerCommand;
      try {
        validated = decodeCodePlannerCommand(command);
      } catch {
        throw invalidCommand();
      }
      return request(
        fetch,
        new URL("/api/code/planner/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeCodePlannerCommandOutcome,
      );
    },
    async executePlannerProposal(command) {
      let validated: CodePlannerProposalCommand;
      try {
        validated = decodeCodePlannerProposalCommand(command);
      } catch {
        throw invalidCommand();
      }
      return request(
        fetch,
        new URL("/api/code/planner/proposals/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeCodePlannerProposalOutcome,
      );
    },
    conversation(threadId, afterCursor, limit, signal) {
      try {
        decodeCodeThreadId(threadId);
        if (
          !Number.isSafeInteger(afterCursor) ||
          afterCursor < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > MAX_CODE_CONVERSATION_PAGE_SIZE
        ) {
          throw new Error("invalid page");
        }
      } catch {
        throw invalidCommand();
      }
      const url = new URL(
        `/api/code/threads/${encodeURIComponent(threadId)}/conversation`,
        options.baseUrl,
      );
      url.searchParams.set("afterCursor", String(afterCursor));
      url.searchParams.set("limit", String(limit));
      return request(
        fetch,
        url.toString(),
        { method: "GET", headers, ...(signal === undefined ? {} : { signal }) },
        decodeCodeConversationPage,
      );
    },
    async putEvidence(threadId, text) {
      try {
        decodeCodeThreadId(threadId);
      } catch {
        throw invalidCommand();
      }
      const trimmed = text.trim();
      if (trimmed.length === 0) throw invalidCommand();
      const bytes = utf8Encoder.encode(text);
      if (bytes.byteLength > MAX_CODE_OPERATION_TEXT_BYTES) throw invalidCommand();
      const response = await requestRaw(
        fetch,
        new URL("/api/code/evidence", options.baseUrl).toString(),
        {
          method: "PUT",
          headers: {
            ...headers,
            "content-type": "text/plain; charset=utf-8",
            "x-octant-code-thread-id": String(threadId),
          },
          body: text,
        },
      );
      if (!response.ok) await rejectFailure(response);
      return decodeCodeEvidenceReference(await response.json());
    },
    async putAttachment(input) {
      try {
        decodeCodeThreadId(input.threadId);
        decodeCodeAttachmentId(input.attachmentId);
        decodeCodeAttachmentMediaType(input.mediaType);
      } catch {
        throw invalidCommand();
      }
      if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_CODE_ATTACHMENT_BYTES) {
        throw invalidCommand();
      }
      if (input.displayName.trim().length === 0) throw invalidCommand();
      const response = await requestRaw(
        fetch,
        new URL("/api/code/attachments", options.baseUrl).toString(),
        {
          method: "PUT",
          headers: {
            ...headers,
            "content-type": input.mediaType,
            "x-octant-code-thread-id": String(input.threadId),
            "x-octant-code-attachment-id": String(input.attachmentId),
            "x-octant-code-display-name": encodeURIComponent(input.displayName),
          },
          body: input.bytes as unknown as BodyInit,
        },
      );
      if (!response.ok) await rejectFailure(response);
      return decodeCodeAttachmentReference(await response.json());
    },
    async discardAttachment(threadId, attachmentId) {
      const url = attachmentUrl(options.baseUrl, threadId, attachmentId);
      const response = await requestRaw(fetch, url.toString(), { method: "DELETE", headers });
      if (!response.ok) await rejectFailure(response);
    },
    async attachment(threadId, reference) {
      const url = attachmentUrl(options.baseUrl, threadId, reference.attachmentId);
      url.searchParams.set("mediaType", reference.mediaType);
      url.searchParams.set("byteLength", String(reference.byteLength));
      url.searchParams.set("digest", reference.digest);
      const response = await requestRaw(fetch, url.toString(), { method: "GET", headers });
      if (!response.ok) await rejectFailure(response);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mediaType: reference.mediaType,
      };
    },
    async content(contentId) {
      try {
        decodeCodeEvidenceContentId(contentId);
      } catch {
        throw invalidContent();
      }
      return readVerifiedContent(
        fetch,
        new URL(`/api/code/content/${encodeURIComponent(contentId)}`, options.baseUrl).toString(),
        headers,
      );
    },
    async operationContent(threadId, operationId, contentId, signal) {
      try {
        decodeCodeThreadId(threadId);
        decodeCodeOperationId(operationId);
        decodeCodeEvidenceContentId(contentId);
      } catch {
        throw invalidContent();
      }
      return readVerifiedContent(
        fetch,
        new URL(
          `/api/code/threads/${encodeURIComponent(threadId)}/operations/${encodeURIComponent(operationId)}/evidence/${encodeURIComponent(contentId)}`,
          options.baseUrl,
        ).toString(),
        headers,
        signal,
      );
    },
    async operationContents(input, signal) {
      let validated: CodeEvidenceBatchRequest;
      try {
        validated = decodeCodeEvidenceBatchRequest(input);
      } catch {
        throw invalidContent();
      }
      return request(
        fetch,
        new URL("/api/code/evidence/batch", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
          ...(signal === undefined ? {} : { signal }),
        },
        decodeCodeEvidenceBatchResponse,
      );
    },
    async save(input) {
      const bytes = validSave(input);
      if (bytes === undefined) throw invalidSave();
      const response = await requestRaw(
        fetch,
        new URL("/api/code/files/content", options.baseUrl).toString(),
        {
          method: "PUT",
          headers: {
            ...headers,
            "content-type": "text/plain; charset=utf-8",
            "x-octant-code-thread-id": String(input.threadId),
            "x-octant-code-checkout-id": String(input.checkoutId),
            "x-octant-code-relative-path": encodeURIComponent(input.path),
            "x-octant-code-file-device": input.expectedIdentity.device,
            "x-octant-code-file-inode": input.expectedIdentity.inode,
            "x-octant-code-expected-digest": input.expectedDigest,
          },
          body: bytes as unknown as BodyInit,
        },
      );
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw malformedResponse();
      }
      if (!response.ok) {
        try {
          throw new CodeClientFailure(decodeCodeFailure(body));
        } catch (error) {
          if (error instanceof CodeClientFailure) throw error;
          throw malformedResponse();
        }
      }
      const result = decodeSaveResponse(body);
      if (result === undefined) throw malformedResponse();
      return result;
    },
    async openFile(threadId, checkoutId, relativePath) {
      try {
        decodeCodeThreadId(threadId);
        decodeCodeCheckoutId(checkoutId);
        decodeCodeRelativePath(relativePath);
      } catch {
        throw invalidCommand();
      }
      const url = new URL("/api/code/files/open", options.baseUrl);
      url.searchParams.set("threadId", String(threadId));
      url.searchParams.set("checkoutId", String(checkoutId));
      url.searchParams.set("path", String(relativePath));
      return request(
        fetch,
        url.toString(),
        { method: "GET", headers },
        (value) => decodeCodeFileOpenResultEnvelope(value).result,
      );
    },
    listTests(threadId, checkoutId) {
      try {
        decodeCodeThreadId(threadId);
        decodeCodeCheckoutId(checkoutId);
      } catch {
        throw invalidCommand();
      }
      const url = new URL("/api/code/tests/listing", options.baseUrl);
      url.searchParams.set("threadId", String(threadId));
      url.searchParams.set("checkoutId", String(checkoutId));
      return request(
        fetch,
        url.toString(),
        { method: "GET", headers },
        decodeCodeRepositoryTestListing,
      );
    },
    subscribe(threadId, afterSequence, signal) {
      if (!validCursor(afterSequence)) return rejectedReplay(invalidCursor());
      const url = new URL(
        `/api/code/threads/${encodeURIComponent(threadId)}/events`,
        options.baseUrl,
      );
      url.searchParams.set("afterSequence", String(afterSequence));
      return parseNdjsonFrames(
        requestRaw(fetch, url.toString(), { method: "GET", headers, signal }),
        threadId,
        afterSequence,
        signal,
      );
    },
    subscribeOperation(threadId, operationId, afterCursor, signal) {
      try {
        decodeCodeThreadId(threadId);
        decodeCodeOperationId(operationId);
      } catch {
        return rejectedOperationReplay(invalidCursor());
      }
      if (!validCursor(afterCursor)) return rejectedOperationReplay(invalidCursor());
      const url = new URL(
        `/api/code/threads/${encodeURIComponent(threadId)}/operations/${encodeURIComponent(operationId)}/events`,
        options.baseUrl,
      );
      url.searchParams.set("afterCursor", String(afterCursor));
      return parseOperationNdjsonFrames(
        requestRaw(fetch, url.toString(), { method: "GET", headers, signal }),
        threadId,
        operationId,
        afterCursor,
        signal,
      );
    },
  };
}

function validateLoopbackBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Octant Code client requires a loopback base URL.");
  }
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (
    !loopback ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Octant Code client requires a loopback base URL.");
  }
}

const utf8Encoder = new TextEncoder();

async function* parseNdjsonFrames(
  responsePromise: Promise<Response>,
  threadId: CodeThreadId,
  afterSequence: number,
  signal: AbortSignal,
): AsyncGenerator<CodeEventFrame> {
  const response = await responsePromise;
  if (!response.ok) await rejectFailure(response);
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bufferByteLength = 0;
  let lastSequence = afterSequence;
  let frameCount = 0;
  try {
    for (;;) {
      if (signal.aborted) return;
      const next = await readStreamChunk(reader, signal);
      if (next.done) break;
      const decodedChunk = decoder.decode(next.value, { stream: true });
      buffer += decodedChunk;
      bufferByteLength += utf8ByteLength(decodedChunk);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        bufferByteLength -= utf8ByteLength(line) + 1;
        if (line.length > 0) {
          const frame = decodeReplayLine(line, threadId, lastSequence);
          if (frame.sequence !== lastSequence + 1) {
            throw new CodeClientSnapshotRequiredError(threadId, afterSequence, frame.sequence);
          }
          if (++frameCount > MAX_CODE_REPLAY_FRAMES) throw malformedResponse();
          lastSequence = frame.sequence;
          yield frame;
        }
        newlineIndex = buffer.indexOf("\n");
      }
      if (bufferByteLength > MAX_CODE_NDJSON_LINE_BYTES) throw malformedResponse();
    }
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      const frame = decodeReplayLine(trailing, threadId, lastSequence);
      if (frame.sequence !== lastSequence + 1) {
        throw new CodeClientSnapshotRequiredError(threadId, afterSequence, frame.sequence);
      }
      if (++frameCount > MAX_CODE_REPLAY_FRAMES) throw malformedResponse();
      yield frame;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation races while tearing down the stream.
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore a reader already released by cancellation.
    }
  }
}

async function* parseOperationNdjsonFrames(
  responsePromise: Promise<Response>,
  threadId: CodeThreadId,
  operationId: CodeOperationId,
  afterCursor: number,
  signal: AbortSignal,
): AsyncGenerator<CodeOperationStreamFrame> {
  const response = await responsePromise;
  if (!response.ok) await rejectFailure(response);
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bufferByteLength = 0;
  let cursor = afterCursor;
  let frameCount = 0;
  const decodeLine = (line: string) => {
    if (utf8ByteLength(line) > MAX_CODE_NDJSON_LINE_BYTES) throw malformedResponse();
    let frame: CodeOperationStreamFrame;
    try {
      frame = decodeCodeOperationStreamFrame(JSON.parse(line));
    } catch {
      throw malformedResponse();
    }
    if (
      frame.threadId !== threadId ||
      frame.operationId !== operationId ||
      frame.cursor <= cursor
    ) {
      throw malformedResponse();
    }
    if (frame.cursor !== cursor + 1) {
      throw new CodeClientSnapshotRequiredError(threadId, afterCursor, frame.cursor);
    }
    cursor = frame.cursor;
    if (++frameCount > MAX_CODE_REPLAY_FRAMES) throw malformedResponse();
    return frame;
  };
  try {
    for (;;) {
      if (signal.aborted) return;
      const next = await readStreamChunk(reader, signal);
      if (next.done) break;
      const decodedChunk = decoder.decode(next.value, { stream: true });
      buffer += decodedChunk;
      bufferByteLength += utf8ByteLength(decodedChunk);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        bufferByteLength -= utf8ByteLength(line) + 1;
        if (line.length > 0) yield decodeLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
      if (bufferByteLength > MAX_CODE_NDJSON_LINE_BYTES) throw malformedResponse();
    }
    const trailing = buffer.trim();
    if (trailing.length > 0) yield decodeLine(trailing);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation races while tearing down the stream.
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore a reader already released by cancellation.
    }
  }
}

function decodeReplayLine(
  line: string,
  threadId: CodeThreadId,
  lastSequence: number,
): CodeEventFrame {
  if (utf8ByteLength(line) > MAX_CODE_NDJSON_LINE_BYTES) throw malformedResponse();
  let frame: CodeEventFrame;
  try {
    frame = decodeCodeEventFrame(JSON.parse(line));
  } catch {
    throw malformedResponse();
  }
  if (String(frame.threadId) !== String(threadId) || frame.sequence <= lastSequence) {
    throw malformedResponse();
  }
  return frame;
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    await reader.cancel();
    return { done: true, value: undefined as undefined };
  }
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reader.cancel().then(
        () => resolve({ done: true, value: undefined as undefined }),
        (error) => reject(error),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  const response = await requestRaw(fetch, url, init);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw malformedResponse();
  }
  if (!response.ok) {
    try {
      throw new CodeClientFailure(decodeCodeFailure(body));
    } catch (error) {
      if (error instanceof CodeClientFailure) throw error;
      throw malformedResponse();
    }
  }
  try {
    return decode(body);
  } catch {
    throw malformedResponse();
  }
}

async function requestRaw(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw unavailable("Octant Code service is unavailable.");
  }
}

async function readVerifiedContent(
  fetcher: typeof globalThis.fetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await requestRaw(fetcher, url, {
    method: "GET",
    headers,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) await rejectFailure(response);
  if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/octet-stream") {
    throw malformedResponse();
  }
  const expectedLength = parseContentLength(response.headers.get("x-octant-content-length"));
  const expectedDigest = response.headers.get("x-octant-content-digest");
  if (
    expectedLength === undefined ||
    expectedLength > MAX_CODE_OPERATION_EVIDENCE_BYTES ||
    !validDigest(expectedDigest)
  ) {
    throw malformedResponse();
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw malformedResponse();
  }
  if (bytes.byteLength !== expectedLength || (await sha256(bytes)) !== expectedDigest) {
    throw malformedResponse();
  }
  return bytes;
}

async function rejectFailure(response: Response): Promise<never> {
  let body: unknown;
  try {
    body = await response.json();
    throw new CodeClientFailure(decodeCodeFailure(body));
  } catch (error) {
    if (error instanceof CodeClientFailure) throw error;
    throw malformedResponse();
  }
}

function validSave(input: CodeFileSave): Uint8Array | undefined {
  try {
    decodeCodeThreadId(input.threadId);
    decodeCodeCheckoutId(input.checkoutId);
    decodeCodeRelativePath(input.path);
  } catch {
    return undefined;
  }
  if (
    !validIdentity(input.expectedIdentity) ||
    !validDigest(input.expectedDigest) ||
    typeof input.text !== "string"
  ) {
    return undefined;
  }
  const bytes = utf8Encoder.encode(input.text);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes) === input.text &&
    bytes.byteLength <= MAX_CODE_FILE_SAVE_BYTES
    ? bytes
    : undefined;
}

function decodeSaveResponse(value: unknown): CodeFileSaveResult | undefined {
  try {
    return decodeCodeFileSaveResultEnvelope(value).result;
  } catch {
    return undefined;
  }
}

function validIdentity(value: unknown): value is CodeFileIdentity {
  return (
    isRecord(value) &&
    exactKeys(value, ["device", "inode"]) &&
    typeof value.device === "string" &&
    value.device.length > 0 &&
    typeof value.inode === "string" &&
    value.inode.length > 0
  );
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validCursor(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function rejectedReplay(error: Error): AsyncIterable<CodeEventFrame> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(error) };
    },
  };
}

function rejectedOperationReplay(error: Error): AsyncIterable<CodeOperationStreamFrame> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(error) };
    },
  };
}

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function decodeBootstrap(value: unknown): CodeBootstrap {
  // `activity` and `runtime` are optional for older hosts; Schema defaults fill them.
  if (!isRecord(value)) throw new Error("invalid");
  const keys = Object.keys(value);
  const allowed = new Set(["settings", "threads", "checkouts", "activity", "runtime"]);
  if (
    !["settings", "threads", "checkouts"].every((key) => keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new Error("invalid");
  }
  if (
    !Array.isArray(value.threads) ||
    !Array.isArray(value.checkouts) ||
    (value.activity !== undefined && !Array.isArray(value.activity)) ||
    (value.runtime !== undefined && !Array.isArray(value.runtime))
  ) {
    throw new Error("invalid");
  }
  return {
    settings: decodeCodeSettings(value.settings),
    threads: value.threads.map((thread) => decodeCodeThread(thread)),
    checkouts: value.checkouts.map((checkout) => decodeCodeCheckoutIdentity(checkout)),
    activity:
      value.activity === undefined
        ? []
        : value.activity.map((entry) => decodeCodeThreadActivity(entry)),
    runtime:
      value.runtime === undefined
        ? []
        : value.runtime.map((entry) => decodeCodeNavigationRuntime(entry)),
  };
}

function decodeThreadView(value: unknown): CodeThreadView {
  if (!isRecord(value) || !exactKeys(value, ["thread", "checkout", "lastSequence"])) {
    throw new Error("invalid");
  }
  if (
    typeof value.lastSequence !== "number" ||
    !Number.isSafeInteger(value.lastSequence) ||
    value.lastSequence < 0
  ) {
    throw new Error("invalid");
  }
  return {
    thread: decodeCodeThread(value.thread),
    checkout: decodeCodeCheckoutIdentity(value.checkout),
    lastSequence: value.lastSequence as CodeThreadView["lastSequence"],
  };
}

function unavailable(message: string): CodeClientFailure {
  return new CodeClientFailure({ category: "unavailable", message });
}

function invalidCommand(): CodeClientFailure {
  return new CodeClientFailure({ category: "invalid", message: "Code command is invalid." });
}

function invalidBoardQuery(): CodeClientFailure {
  return new CodeClientFailure({ category: "invalid", message: "Code board query is invalid." });
}

function invalidProjectPullRequestQuery(): CodeClientFailure {
  return new CodeClientFailure({
    category: "invalid",
    message: "Code project pull-request query is invalid.",
  });
}

function invalidProjectPullRequestRefresh(): CodeClientFailure {
  return new CodeClientFailure({
    category: "invalid",
    message: "Code project pull-request refresh is invalid.",
  });
}

function invalidProjectPullRequestDetailQuery(): CodeClientFailure {
  return new CodeClientFailure({
    category: "invalid",
    message: "Code project pull-request detail query is invalid.",
  });
}

function invalidProjectPullRequestDetailRefresh(): CodeClientFailure {
  return new CodeClientFailure({
    category: "invalid",
    message: "Code project pull-request detail refresh is invalid.",
  });
}

function invalidSave(): CodeClientFailure {
  return new CodeClientFailure({ category: "invalid", message: "Code file save is invalid." });
}

function invalidContent(): CodeClientFailure {
  return new CodeClientFailure({ category: "invalid", message: "Code content ID is invalid." });
}

function invalidCursor(): CodeClientFailure {
  return new CodeClientFailure({ category: "invalid", message: "Code replay cursor is invalid." });
}

function malformedResponse(): CodeClientFailure {
  return new CodeClientFailure({
    category: "unavailable",
    message: "Code service returned an invalid response.",
  });
}
