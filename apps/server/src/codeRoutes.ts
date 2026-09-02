import {
  CodeCheckoutId,
  CodeDigest,
  CodeEvidenceContentId,
  GlobalSequence,
  MAX_CODE_OPERATION_EVIDENCE_BYTES,
  MAX_CODE_OPERATION_TEXT_BYTES,
  MAX_CODE_EVIDENCE_BATCH_ITEMS,
  MAX_CODE_ATTACHMENT_BYTES,
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  decodeCodeAttachmentId,
  decodeCodeAttachmentMediaType,
  decodeCodeAttachmentReference,
  decodeCodeBoardQuery,
  decodeCodeBoardView,
  decodeCodeProjectPullRequestQuery,
  decodeCodeProjectPullRequestRefreshCommand,
  decodeCodeProjectPullRequestView,
  decodeCodeProjectPullRequestDetailQuery,
  decodeCodeProjectPullRequestDetailRefreshCommand,
  decodeCodeProjectPullRequestDetailView,
  decodeCodeCommand,
  decodeCodeEvidenceReference,
  decodeCodeEvidenceBatchRequest,
  decodeCodeEvidenceBatchResponse,
  decodeCodeEventFrame,
  decodeCodeFailure,
  decodeCodeOperationCommand,
  decodeCodeOperationEventFrame,
  decodeCodeOperationStreamFrame,
  decodeCodeOperationId,
  decodeCodeOperationResult,
  decodeCodeTerminalInspection,
  decodeCodeTerminalInspectionRequest,
  decodeCodeConversationPage,
  MAX_CODE_SEARCH_QUERY_LENGTH,
  decodeCodeFileChangeNotice,
  decodeCodeFileListingResult,
  decodeCodeSearchResult,
  decodeCodeFileOpenResultEnvelope,
  decodeCodeFileSaveResultEnvelope,
  decodeCodeFollowUpCommand,
  decodeCodePlannerCommand,
  decodeCodePlannerCommandOutcome,
  decodeCodePlannerProposalCommand,
  decodeCodePlannerProposalOutcome,
  decodeCodePlannerView,
  decodeCodeRepositoryTestListing,
  decodeCodeRelativePath,
  decodeCodeThreadFollowUpUpdated,
  decodeCodeThreadFollowUpView,
  decodeCodeThreadId,
  type CodeBoardQuery,
  type CodeBoardView,
  type CodeProjectPullRequestQuery,
  type CodeProjectPullRequestRefreshCommand,
  type CodeProjectPullRequestView,
  type CodeProjectPullRequestDetailQuery,
  type CodeProjectPullRequestDetailRefreshCommand,
  type CodeProjectPullRequestDetailView,
  type CodeAttachmentId,
  type CodeAttachmentMediaType,
  type CodeAttachmentReference,
  type CodeBootstrap,
  type CodeNavigation,
  type CodeCommand,
  type CodeCommandResult,
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
  type CodeOperationCommand,
  type CodeOperationEventFrame,
  type CodeOperationStreamFrame,
  type CodeOperationId,
  type CodeOperationResult,
  type CodeTerminalInspection,
  type CodeTerminalInspectionRequest,
  type CodeConversationPage,
  type CodeFileChangeNotice,
  type CodeSearchResult,
  type CodeSearchScope,
  type CodeFileListingResult,
  type CodeFileOpenResultEnvelope,
  type CodeFileSaveResultEnvelope,
  type CodeRelativePath,
  type CodeRepositoryTestListing,
  type CodeThreadFollowUpUpdated,
  type CodeThreadFollowUpView,
  type CodeThreadId,
  type CodeThreadView,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { FileIdentity } from "./code/fileOperationPort";
import { MAX_EDITABLE_CODE_FILE_BYTES } from "./code/codeFileService";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

export const MAX_CODE_JSON_BODY_SIZE = 1_048_576;
export const MAX_CODE_FILE_BODY_SIZE = MAX_EDITABLE_CODE_FILE_BYTES;
export const MAX_CODE_NDJSON_LINE_BYTES = 1_048_576;
export const MAX_CODE_REPLAY_FRAMES = 100;

// DELETE is here for taking a staged attachment back before it is sent.
const METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const HEADERS = [
  "content-type",
  "x-octant-window-capability",
  "x-octant-code-thread-id",
  "x-octant-code-checkout-id",
  "x-octant-code-relative-path",
  "x-octant-code-file-device",
  "x-octant-code-file-inode",
  "x-octant-code-expected-digest",
  "x-octant-code-attachment-id",
  "x-octant-code-display-name",
].join(", ");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeGlobalSequence = Schema.decodeUnknownSync(GlobalSequence);
const decodeCheckoutId = Schema.decodeUnknownSync(CodeCheckoutId);
const decodeContentId = Schema.decodeUnknownSync(CodeEvidenceContentId);
const decodeDigest = Schema.decodeUnknownSync(CodeDigest);
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

export interface CodeContentRead {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly byteLength: number;
}

export interface CodeFileSaveInput {
  readonly threadId: CodeThreadId;
  readonly checkoutId: typeof CodeCheckoutId.Type;
  readonly relativePath: ReturnType<typeof decodeCodeRelativePath>;
  readonly expectedIdentity: FileIdentity;
  readonly expectedDigest: string;
  readonly text: string;
}

export interface CodeFileListingInput {
  readonly threadId: CodeThreadId;
  readonly checkoutId: typeof CodeCheckoutId.Type;
  /** Subdirectory relative to the checkout root. Absent lists the root. */
  readonly directory?: CodeRelativePath | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface CodeSearchFilesInput {
  readonly threadId: CodeThreadId;
  readonly checkoutId: typeof CodeCheckoutId.Type;
  readonly scope: CodeSearchScope;
  readonly query: string;
  readonly signal?: AbortSignal | undefined;
}

export interface CodeFileWatchInput {
  readonly threadId: CodeThreadId;
  readonly checkoutId: typeof CodeCheckoutId.Type;
  readonly signal?: AbortSignal | undefined;
}

export interface CodeFileOpenInput {
  readonly threadId: CodeThreadId;
  readonly checkoutId: typeof CodeCheckoutId.Type;
  readonly relativePath: CodeRelativePath;
  readonly signal?: AbortSignal | undefined;
}

export interface CodeTestListingInput {
  readonly threadId: CodeThreadId;
  readonly checkoutId: typeof CodeCheckoutId.Type;
}

export interface CodeRouteService {
  readonly bootstrap: (authenticatedWindowId: WindowId) => Promise<CodeBootstrap> | CodeBootstrap;
  readonly navigation: (
    authenticatedWindowId: WindowId,
  ) => Promise<CodeNavigation> | CodeNavigation;
  readonly read: (
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
  ) => Promise<CodeThreadView> | CodeThreadView;
  readonly execute: (
    authenticatedWindowId: WindowId,
    command: CodeCommand,
    signal?: AbortSignal,
  ) => Promise<CodeCommandResult> | CodeCommandResult;
  readonly executeOperation?: (
    authenticatedWindowId: WindowId,
    command: CodeOperationCommand,
    options?: { readonly initiator?: "user" | "agent" },
  ) => Promise<CodeOperationResult> | CodeOperationResult;
  readonly inspectTerminal?: (
    authenticatedWindowId: WindowId,
    input: CodeTerminalInspectionRequest,
  ) => Promise<CodeTerminalInspection> | CodeTerminalInspection;
  readonly subscribe: (
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
    afterSequence: number,
    signal?: AbortSignal,
  ) => AsyncIterable<CodeEventFrame>;
  readonly subscribeOperation?: (
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    afterCursor: number,
    signal?: AbortSignal,
  ) => AsyncIterable<CodeOperationEventFrame>;
  readonly conversation?: (
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
    afterCursor: number,
    limit: number,
  ) => Promise<CodeConversationPage> | CodeConversationPage;
  readonly queryBoard?: (
    authenticatedWindowId: WindowId,
    query: CodeBoardQuery,
  ) => Promise<CodeBoardView> | CodeBoardView;
  readonly queryProjectPullRequests?: (
    authenticatedWindowId: WindowId,
    query: CodeProjectPullRequestQuery,
  ) => Promise<CodeProjectPullRequestView> | CodeProjectPullRequestView;
  readonly refreshProjectPullRequests?: (
    authenticatedWindowId: WindowId,
    command: CodeProjectPullRequestRefreshCommand,
    signal?: AbortSignal,
  ) => Promise<CodeProjectPullRequestView> | CodeProjectPullRequestView;
  readonly queryProjectPullRequestDetail?: (
    authenticatedWindowId: WindowId,
    query: CodeProjectPullRequestDetailQuery,
  ) => Promise<CodeProjectPullRequestDetailView> | CodeProjectPullRequestDetailView;
  readonly refreshProjectPullRequestDetail?: (
    authenticatedWindowId: WindowId,
    command: CodeProjectPullRequestDetailRefreshCommand,
    signal?: AbortSignal,
  ) => Promise<CodeProjectPullRequestDetailView> | CodeProjectPullRequestDetailView;
  /**
   * The Project's planner designation and proposals. Optional like the board:
   * a host without the planner capability answers `unavailable`, not 404.
   */
  readonly readPlanner?: (
    authenticatedWindowId: WindowId,
    projectId: string,
  ) => Promise<CodePlannerView> | CodePlannerView;
  readonly executePlanner?: (
    authenticatedWindowId: WindowId,
    command: CodePlannerCommand,
  ) => Promise<CodePlannerCommandOutcome> | CodePlannerCommandOutcome;
  readonly executePlannerProposal?: (
    authenticatedWindowId: WindowId,
    command: CodePlannerProposalCommand,
    signal?: AbortSignal,
  ) => Promise<CodePlannerProposalOutcome> | CodePlannerProposalOutcome;
  readonly readFollowUp?: (
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
  ) => Promise<CodeThreadFollowUpView> | CodeThreadFollowUpView;
  readonly executeFollowUp?: (
    authenticatedWindowId: WindowId,
    command: CodeFollowUpCommand,
  ) => Promise<CodeThreadFollowUpUpdated> | CodeThreadFollowUpUpdated;
  readonly readContent: (
    authenticatedWindowId: WindowId,
    contentId: string,
  ) => Promise<CodeContentRead> | CodeContentRead;
  readonly readOperationContent?: (
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    contentId: string,
  ) => Promise<CodeContentRead> | CodeContentRead;
  readonly readOperationContents?: (
    authenticatedWindowId: WindowId,
    input: CodeEvidenceBatchRequest,
  ) => Promise<CodeEvidenceBatchResponse> | CodeEvidenceBatchResponse;
  readonly saveFile: (
    authenticatedWindowId: WindowId,
    input: CodeFileSaveInput,
  ) => Promise<CodeFileSaveResultEnvelope> | CodeFileSaveResultEnvelope;
  /**
   * Open a confined file for the editor surface (#code-file tabs). Like
   * `saveFile`, the caller supplies only thread-relative identity; root
   * resolution and authority stay server-side.
   */
  readonly openFile: (
    authenticatedWindowId: WindowId,
    input: CodeFileOpenInput,
  ) => Promise<CodeFileOpenResultEnvelope> | CodeFileOpenResultEnvelope;
  /**
   * Confined listing of the checkout bound to a thread (#code-file-explorer).
   * Optional so a host without a listing capability answers `unavailable`
   * rather than 404, which is the honest distinction between "this host cannot
   * list" and "this route does not exist".
   */
  readonly listFiles?: (
    authenticatedWindowId: WindowId,
    input: CodeFileListingInput,
  ) => Promise<CodeFileListingResult> | CodeFileListingResult;
  /**
   * Bounded search of the thread's checkout by path or by content. Optional
   * for the same reason as `listFiles`.
   */
  readonly searchFiles?: (
    authenticatedWindowId: WindowId,
    input: CodeSearchFilesInput,
  ) => Promise<CodeSearchResult> | CodeSearchResult;
  /**
   * Live notices that files under the thread's checkout changed. Optional for
   * the same reason as `listFiles`: a host with no watcher answers
   * `unavailable` rather than 404, and the renderer keeps manual refresh.
   *
   * The stream may be promised so the host can authorize before handing one
   * back; a rejection then still has a status code to become.
   */
  /**
   * End the file watches a window left open, because its capability was
   * revoked. Optional: a host with no watching has nothing to end.
   */
  readonly revokeWindow?: (windowId: WindowId) => void;
  readonly watchFiles?: (
    authenticatedWindowId: WindowId,
    input: CodeFileWatchInput,
  ) => AsyncIterable<CodeFileChangeNotice> | Promise<AsyncIterable<CodeFileChangeNotice>>;
  /**
   * The repository tests the thread's checkout offers. Optional for the same
   * reason as `listFiles`: a host with no discovery answers `unavailable`
   * rather than 404, so "this host cannot discover tests" stays distinct from
   * "this route does not exist".
   */
  readonly listTests?: (
    authenticatedWindowId: WindowId,
    input: CodeTestListingInput,
  ) => Promise<CodeRepositoryTestListing> | CodeRepositoryTestListing;
  readonly stageEvidence?: (
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
    text: string,
  ) => Promise<CodeEvidenceReference> | CodeEvidenceReference;
  readonly stageAttachment?: (
    authenticatedWindowId: WindowId,
    input: {
      readonly threadId: CodeThreadId;
      readonly attachmentId: CodeAttachmentId;
      readonly displayName: string;
      readonly mediaType: CodeAttachmentMediaType;
      readonly bytes: Uint8Array;
      readonly signal?: AbortSignal;
    },
  ) => Promise<CodeAttachmentReference>;
  readonly readAttachment?: (
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
    input: {
      readonly attachmentId: CodeAttachmentId;
      readonly byteLength: number;
      readonly digest: string;
    },
  ) => Promise<Uint8Array>;
  readonly discardAttachment?: (
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
    attachmentId: CodeAttachmentId,
  ) => Promise<void>;
}

export interface CodeRouteDependencies {
  readonly service: CodeRouteService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxJsonBodySize?: number;
  readonly maxFileBodySize?: number;
  readonly now?: () => number;
}

export function createCodeRouteHandler(dependencies: CodeRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? MAX_CODE_JSON_BODY_SIZE;
  const fileLimit = dependencies.maxFileBodySize ?? MAX_CODE_FILE_BODY_SIZE;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/code/")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse(
        { category: "unsupported", message: "Code API requests must use loopback." },
        400,
        null,
      );
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse(
        { category: "unsupported", message: "Renderer origin is not allowed." },
        400,
        null,
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const route = matchRoute(url.pathname);
    if (route === undefined) return undefined;

    let authenticatedWindowId: WindowId;
    // Only the person at a local desktop window speaks as `user`. The same
    // route chain serves the authenticated remote gateway, so a paired device
    // stays gated as an agent and cannot skip a Code approval by reaching the
    // route directly.
    let operationInitiator: "user" | "agent";
    try {
      if (url.searchParams.has("windowId")) {
        throw new CodeRouteRejected("Code requests cannot supply window identity.", 400);
      }
      const principalContext = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      authenticatedWindowId = principalContext.scopeId;
      operationInitiator = principalContext.principal.kind === "local-window" ? "user" : "agent";
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse(
          { category: "unauthorized", message: "Code request is unauthorized." },
          401,
          origin,
        );
      }
      return failureResponse(
        { category: "invalid", message: publicMessage(error, "Code request is invalid.") },
        error instanceof CodeRouteRejected ? error.status : 400,
        origin,
      );
    }

    try {
      switch (route.kind) {
        case "bootstrap":
          requireMethodAndEmptyQuery(request, url, "GET");
          return jsonResponse(
            await dependencies.service.bootstrap(authenticatedWindowId),
            200,
            origin,
          );
        case "navigation":
          requireMethodAndEmptyQuery(request, url, "GET");
          return jsonResponse(
            await dependencies.service.navigation(authenticatedWindowId),
            200,
            origin,
          );
        case "thread": {
          requireMethodAndEmptyQuery(request, url, "GET");
          const threadId = decodePathThreadId(route.threadId);
          return jsonResponse(
            await dependencies.service.read(authenticatedWindowId, threadId),
            200,
            origin,
          );
        }
        case "commands": {
          requireMethodAndEmptyQuery(request, url, "POST");
          requireJsonContentType(request);
          const body = await readBoundedBytes(request, jsonLimit);
          const value = parseJson(body);
          if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "windowId")) {
            throw new CodeRouteRejected("Code requests cannot supply window identity.", 400);
          }
          let command: CodeCommand | undefined;
          try {
            command = decodeCodeCommand(value);
          } catch {
            // The authenticated command endpoint also carries strict Code operations.
          }
          if (command !== undefined) {
            return jsonResponse(
              await dependencies.service.execute(authenticatedWindowId, command, request.signal),
              200,
              origin,
            );
          }
          let operation: CodeOperationCommand;
          try {
            operation = decodeCodeOperationCommand(value);
          } catch {
            throw new CodeRouteRejected("Code command is invalid.", 400);
          }
          if (dependencies.service.executeOperation === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code operations are unavailable." },
              503,
              origin,
            );
          }
          const operationResult = decodeCodeOperationResult(
            await dependencies.service.executeOperation(authenticatedWindowId, operation, {
              initiator: operationInitiator,
            }),
          );
          if (operationResult.operationId !== operation.operationId) {
            throw new CodeRouteRejected("Code operation response is unavailable.", 503);
          }
          return jsonResponse(operationResult, 200, origin);
        }
        case "terminal-inspection": {
          requireMethodAndEmptyQuery(request, url, "POST");
          requireJsonContentType(request);
          if (dependencies.service.inspectTerminal === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code terminal inspection is unavailable." },
              503,
              origin,
            );
          }
          const body = await readBoundedBytes(request, jsonLimit);
          const value = parseJson(body);
          if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "windowId")) {
            throw new CodeRouteRejected("Code requests cannot supply window identity.", 400);
          }
          let input: CodeTerminalInspectionRequest;
          try {
            input = decodeCodeTerminalInspectionRequest(value);
          } catch {
            throw new CodeRouteRejected("Code terminal inspection is invalid.", 400);
          }
          return jsonResponse(
            decodeCodeTerminalInspection(
              await dependencies.service.inspectTerminal(authenticatedWindowId, input),
            ),
            200,
            origin,
          );
        }
        case "events": {
          if (request.method !== "GET") {
            throw new CodeRouteRejected("HTTP method is not supported for this route.", 400);
          }
          const threadId = decodePathThreadId(route.threadId);
          const afterSequence = decodeReplayCursor(url);
          const frames: CodeEventFrame[] = [];
          for await (const frame of dependencies.service.subscribe(
            authenticatedWindowId,
            threadId,
            afterSequence,
            request.signal,
          )) {
            frames.push(decodeCodeEventFrame(frame));
            if (frames.length === MAX_CODE_REPLAY_FRAMES) break;
          }
          return ndjsonResponse(frames, origin);
        }
        case "operation-events": {
          if (request.method !== "GET" || dependencies.service.subscribeOperation === undefined) {
            throw new CodeRouteRejected("Code operation replay is unavailable.", 503);
          }
          const threadId = decodePathThreadId(route.threadId);
          const operationId = decodePathOperationId(route.operationId);
          const afterCursor = decodeOperationReplayCursor(url);
          const frames: CodeOperationEventFrame[] = [];
          let cursor = afterCursor;
          for await (const value of dependencies.service.subscribeOperation(
            authenticatedWindowId,
            threadId,
            operationId,
            afterCursor,
            request.signal,
          )) {
            const frame = decodeCodeOperationEventFrame(value);
            if (
              frame.threadId !== threadId ||
              frame.operationId !== operationId ||
              frame.cursor !== cursor + 1
            ) {
              throw new CodeRouteRejected("Code operation replay requires a snapshot.", 409);
            }
            cursor = frame.cursor;
            frames.push(frame);
            if (frames.length === MAX_CODE_REPLAY_FRAMES) break;
          }
          let streamFrames: ReadonlyArray<CodeOperationStreamFrame> = frames.map((frame) =>
            decodeCodeOperationStreamFrame(frame),
          );
          if (dependencies.service.readOperationContents !== undefined) {
            const references = new Map<
              string,
              { readonly operationId: CodeOperationId; readonly contentId: CodeEvidenceContentId }
            >();
            for (const frame of frames) {
              if (frame.event.kind !== "provider-content") continue;
              references.set(`${frame.operationId}:${frame.event.content.contentId}`, {
                operationId: frame.operationId,
                contentId: frame.event.content.contentId,
              });
            }
            if (references.size > 0) {
              try {
                const items = [...references.values()];
                const batches = await Promise.all(
                  Array.from(
                    { length: Math.ceil(items.length / MAX_CODE_EVIDENCE_BATCH_ITEMS) },
                    (_, index) =>
                      dependencies.service.readOperationContents?.(authenticatedWindowId, {
                        threadId,
                        items: items.slice(
                          index * MAX_CODE_EVIDENCE_BATCH_ITEMS,
                          (index + 1) * MAX_CODE_EVIDENCE_BATCH_ITEMS,
                        ),
                      }),
                  ),
                );
                const text = new Map(
                  batches.flatMap((contents) =>
                    (contents?.items ?? []).map((item) => [
                      `${item.operationId}:${item.contentId}`,
                      item.text,
                    ]),
                  ),
                );
                streamFrames = frames.map((frame) => {
                  const displayText =
                    frame.event.kind === "provider-content"
                      ? text.get(`${frame.operationId}:${frame.event.content.contentId}`)
                      : undefined;
                  return decodeCodeOperationStreamFrame({
                    ...frame,
                    ...(displayText === undefined ? {} : { displayText }),
                  });
                });
              } catch {
                // The durable reference still lets older clients recover the
                // text through the evidence route when enrichment is unavailable.
              }
            }
          }
          return ndjsonResponse(streamFrames, origin);
        }
        case "conversation": {
          if (request.method !== "GET" || dependencies.service.conversation === undefined) {
            throw new CodeRouteRejected("Code conversation is unavailable.", 503);
          }
          const threadId = decodePathThreadId(route.threadId);
          const { afterCursor, limit } = decodeConversationPageQuery(url);
          return jsonResponse(
            decodeCodeConversationPage(
              await dependencies.service.conversation(
                authenticatedWindowId,
                threadId,
                afterCursor,
                limit,
              ),
            ),
            200,
            origin,
          );
        }
        case "follow-up": {
          const threadId = decodePathThreadId(route.threadId);
          if (request.method === "GET") {
            requireMethodAndEmptyQuery(request, url, "GET");
            if (dependencies.service.readFollowUp === undefined) {
              return failureResponse(
                { category: "unavailable", message: "Code follow-up is unavailable." },
                503,
                origin,
              );
            }
            return jsonResponse(
              decodeCodeThreadFollowUpView(
                await dependencies.service.readFollowUp(authenticatedWindowId, threadId),
              ),
              200,
              origin,
            );
          }
          requireMethodAndEmptyQuery(request, url, "POST");
          requireJsonContentType(request);
          if (dependencies.service.executeFollowUp === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code follow-up is unavailable." },
              503,
              origin,
            );
          }
          const body = await readBoundedBytes(request, jsonLimit);
          const value = parseJson(body);
          if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "windowId")) {
            throw new CodeRouteRejected("Code requests cannot supply window identity.", 400);
          }
          let command: CodeFollowUpCommand;
          try {
            command = decodeCodeFollowUpCommand(value);
          } catch {
            throw new CodeRouteRejected("Code follow-up command is invalid.", 400);
          }
          if (String(command.threadId) !== String(threadId)) {
            throw new CodeRouteRejected("Code follow-up thread mismatch.", 400);
          }
          return jsonResponse(
            decodeCodeThreadFollowUpUpdated(
              await dependencies.service.executeFollowUp(authenticatedWindowId, command),
            ),
            200,
            origin,
          );
        }
        case "board": {
          requireMethodAndEmptyQuery(request, url, "POST");
          requireJsonContentType(request);
          if (dependencies.service.queryBoard === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code Thread Board is unavailable." },
              503,
              origin,
            );
          }
          const body = await readBoundedBytes(request, jsonLimit);
          const value = parseJson(body);
          if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "windowId")) {
            throw new CodeRouteRejected("Code requests cannot supply window identity.", 400);
          }
          let query: CodeBoardQuery;
          try {
            query = decodeCodeBoardQuery(value);
          } catch {
            throw new CodeRouteRejected("Code board query is invalid.", 400);
          }
          return jsonResponse(
            decodeCodeBoardView(
              await dependencies.service.queryBoard(authenticatedWindowId, query),
            ),
            200,
            origin,
          );
        }
        case "planner": {
          requireMethodAndEmptyQuery(request, url, "GET");
          if (dependencies.service.readPlanner === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code planner is unavailable." },
              503,
              origin,
            );
          }
          return jsonResponse(
            decodeCodePlannerView(
              await dependencies.service.readPlanner(authenticatedWindowId, route.projectId),
            ),
            200,
            origin,
          );
        }
        case "planner-commands": {
          requireMethodAndEmptyQuery(request, url, "POST");
          requireJsonContentType(request);
          // Designating a planner is the person's act. The same route chain
          // serves the authenticated remote gateway, where a paired device is
          // gated as an agent — it may watch the planner, never appoint one.
          if (operationInitiator !== "user") {
            return failureResponse(
              {
                category: "unauthorized",
                message: "Planner designation requires the local user.",
              },
              origin,
            );
          }
          if (dependencies.service.executePlanner === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code planner is unavailable." },
              503,
              origin,
            );
          }
          const body = await readBoundedBytes(request, jsonLimit);
          const value = parseJson(body);
          refuseRendererAuthoredIdentity(value);
          let command: CodePlannerCommand;
          try {
            command = decodeCodePlannerCommand(value);
          } catch {
            throw new CodeRouteRejected("Code planner command is invalid.", 400);
          }
          return jsonResponse(
            decodeCodePlannerCommandOutcome(
              await dependencies.service.executePlanner(authenticatedWindowId, command),
            ),
            200,
            origin,
          );
        }
        case "planner-proposal-commands": {
          requireMethodAndEmptyQuery(request, url, "POST");
          requireJsonContentType(request);
          // Confirming a proposal creates a thread; declining discards one.
          // Both are the explicit user decision the proposal exists to wait
          // for, so an agent-gated principal is refused before any effect.
          if (operationInitiator !== "user") {
            return failureResponse(
              {
                category: "unauthorized",
                message: "Resolving a planner proposal requires the local user.",
              },
              origin,
            );
          }
          if (dependencies.service.executePlannerProposal === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code planner is unavailable." },
              503,
              origin,
            );
          }
          const body = await readBoundedBytes(request, jsonLimit);
          const value = parseJson(body);
          refuseRendererAuthoredIdentity(value);
          let command: CodePlannerProposalCommand;
          try {
            command = decodeCodePlannerProposalCommand(value);
          } catch {
            throw new CodeRouteRejected("Code planner proposal command is invalid.", 400);
          }
          return jsonResponse(
            decodeCodePlannerProposalOutcome(
              await dependencies.service.executePlannerProposal(
                authenticatedWindowId,
                command,
                request.signal,
              ),
            ),
            200,
            origin,
          );
        }
        case "project-pull-requests": {
          requireMethodAndEmptyQuery(request, url, "POST");
          requireJsonContentType(request);
          if (dependencies.service.queryProjectPullRequests === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code project pull requests are unavailable." },
              503,
              origin,
            );
          }
          const body = await readBoundedBytes(request, jsonLimit);
          const value = parseJson(body);
          refuseRendererAuthoredIdentity(value);
          let query: CodeProjectPullRequestQuery;
          try {
            query = decodeCodeProjectPullRequestQuery(value);
          } catch {
            throw new CodeRouteRejected("Code project pull-request query is invalid.", 400);
          }
          return jsonResponse(
            decodeCodeProjectPullRequestView(
              await dependencies.service.queryProjectPullRequests(authenticatedWindowId, query),
            ),
            200,
            origin,
          );
        }
        case "project-pull-requests-refresh": {
          requireMethodAndEmptyQuery(request, url, "POST");
          requireJsonContentType(request);
          if (dependencies.service.refreshProjectPullRequests === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code project pull requests are unavailable." },
              503,
              origin,
            );
          }
          const body = await readBoundedBytes(request, jsonLimit);
          const value = parseJson(body);
          refuseRendererAuthoredIdentity(value);
          let command: CodeProjectPullRequestRefreshCommand;
          try {
            command = decodeCodeProjectPullRequestRefreshCommand(value);
          } catch {
            throw new CodeRouteRejected("Code project pull-request refresh is invalid.", 400);
          }
          return jsonResponse(
            decodeCodeProjectPullRequestView(
              await dependencies.service.refreshProjectPullRequests(
                authenticatedWindowId,
                command,
                request.signal,
              ),
            ),
            200,
            origin,
          );
        }
        case "project-pull-requests-detail": {
          requireMethodAndEmptyQuery(request, url, "POST");
          requireJsonContentType(request);
          if (dependencies.service.queryProjectPullRequestDetail === undefined) {
            return failureResponse(
              {
                category: "unavailable",
                message: "Code project pull-request detail is unavailable.",
              },
              503,
              origin,
            );
          }
          const body = await readBoundedBytes(request, jsonLimit);
          const value = parseJson(body);
          refuseRendererAuthoredIdentity(value);
          let query: CodeProjectPullRequestDetailQuery;
          try {
            query = decodeCodeProjectPullRequestDetailQuery(value);
          } catch {
            throw new CodeRouteRejected("Code project pull-request detail query is invalid.", 400);
          }
          return jsonResponse(
            decodeCodeProjectPullRequestDetailView(
              await dependencies.service.queryProjectPullRequestDetail(
                authenticatedWindowId,
                query,
              ),
            ),
            200,
            origin,
          );
        }
        case "project-pull-requests-detail-refresh": {
          requireMethodAndEmptyQuery(request, url, "POST");
          requireJsonContentType(request);
          if (dependencies.service.refreshProjectPullRequestDetail === undefined) {
            return failureResponse(
              {
                category: "unavailable",
                message: "Code project pull-request detail refresh is unavailable.",
              },
              503,
              origin,
            );
          }
          const body = await readBoundedBytes(request, jsonLimit);
          const value = parseJson(body);
          refuseRendererAuthoredIdentity(value);
          let command: CodeProjectPullRequestDetailRefreshCommand;
          try {
            command = decodeCodeProjectPullRequestDetailRefreshCommand(value);
          } catch {
            throw new CodeRouteRejected(
              "Code project pull-request detail refresh is invalid.",
              400,
            );
          }
          return jsonResponse(
            decodeCodeProjectPullRequestDetailView(
              await dependencies.service.refreshProjectPullRequestDetail(
                authenticatedWindowId,
                command,
                request.signal,
              ),
            ),
            200,
            origin,
          );
        }
        case "operation-content": {
          requireMethodAndEmptyQuery(request, url, "GET");
          if (dependencies.service.readOperationContent === undefined) {
            throw new CodeRouteRejected("Code operation evidence is unavailable.", 503);
          }
          const threadId = decodePathThreadId(route.threadId);
          const operationId = decodePathOperationId(route.operationId);
          const contentId = decodePathContentId(route.contentId);
          return contentResponse(
            await dependencies.service.readOperationContent(
              authenticatedWindowId,
              threadId,
              operationId,
              contentId,
            ),
            origin,
          );
        }
        case "content": {
          requireMethodAndEmptyQuery(request, url, "GET");
          const contentId = decodePathContentId(route.contentId);
          const content = await dependencies.service.readContent(authenticatedWindowId, contentId);
          return contentResponse(content, origin);
        }
        case "file-save": {
          requireMethodAndEmptyQuery(request, url, "PUT");
          requireTextContentType(request);
          const metadata = decodeFileSaveHeaders(request.headers);
          const body = await readBoundedBytes(request, fileLimit);
          let text: string;
          try {
            text = fatalUtf8.decode(body);
          } catch {
            throw new CodeRouteRejected("Code file content must be valid UTF-8.", 400);
          }
          const result = await dependencies.service.saveFile(authenticatedWindowId, {
            ...metadata,
            text,
          });
          return jsonResponse(decodeCodeFileSaveResultEnvelope(result), 200, origin);
        }
        case "file-open": {
          if (request.method !== "GET") {
            throw new CodeRouteRejected("Code request is invalid.", 400);
          }
          const openInput = decodeFileOpenQuery(url);
          return jsonResponse(
            decodeCodeFileOpenResultEnvelope(
              await dependencies.service.openFile(authenticatedWindowId, {
                ...openInput,
                signal: request.signal,
              }),
            ),
            200,
            origin,
          );
        }
        case "file-listing": {
          if (request.method !== "GET") {
            throw new CodeRouteRejected("Code request is invalid.", 400);
          }
          if (dependencies.service.listFiles === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code file listing is unavailable." },
              503,
              origin,
            );
          }
          const listingInput = decodeFileListingQuery(url);
          return jsonResponse(
            decodeCodeFileListingResult(
              await dependencies.service.listFiles(authenticatedWindowId, {
                ...listingInput,
                signal: request.signal,
              }),
            ),
            200,
            origin,
          );
        }
        case "file-search": {
          if (request.method !== "GET") {
            throw new CodeRouteRejected("Code request is invalid.", 400);
          }
          if (dependencies.service.searchFiles === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code search is unavailable." },
              503,
              origin,
            );
          }
          const searchInput = decodeFileSearchQuery(url);
          return jsonResponse(
            decodeCodeSearchResult(
              await dependencies.service.searchFiles(authenticatedWindowId, {
                ...searchInput,
                signal: request.signal,
              }),
            ),
            200,
            origin,
          );
        }
        case "file-watch": {
          if (request.method !== "GET") {
            throw new CodeRouteRejected("Code request is invalid.", 400);
          }
          if (dependencies.service.watchFiles === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code file watching is unavailable." },
              503,
              origin,
            );
          }
          const watchInput = decodeFileWatchQuery(url);
          // Awaited here, not inside the stream: a watch the host refuses must
          // fail while this call can still answer with a status. Once the
          // response exists the only thing left to say is "the stream ended",
          // which the client cannot tell from a dropped connection.
          const notices = await dependencies.service.watchFiles(authenticatedWindowId, {
            ...watchInput,
            signal: request.signal,
          });
          return noticeStreamResponse(notices, request.signal, origin);
        }
        case "test-listing": {
          if (request.method !== "GET") {
            throw new CodeRouteRejected("Code request is invalid.", 400);
          }
          if (dependencies.service.listTests === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code repository test listing is unavailable." },
              503,
              origin,
            );
          }
          return jsonResponse(
            decodeCodeRepositoryTestListing(
              await dependencies.service.listTests(
                authenticatedWindowId,
                decodeTestListingQuery(url),
              ),
            ),
            200,
            origin,
          );
        }
        case "stage-evidence": {
          requireMethodAndEmptyQuery(request, url, "PUT");
          requireTextContentType(request);
          if (dependencies.service.stageEvidence === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code evidence staging is unavailable." },
              503,
              origin,
            );
          }
          const threadHeader = request.headers.get("x-octant-code-thread-id");
          if (threadHeader === null || threadHeader.trim() === "") {
            throw new CodeRouteRejected("Code evidence requires a thread identity.", 400);
          }
          const threadId = decodeCodeThreadId(threadHeader);
          const body = await readBoundedBytes(request, MAX_CODE_OPERATION_TEXT_BYTES);
          let text: string;
          try {
            text = fatalUtf8.decode(body);
          } catch {
            throw new CodeRouteRejected("Code evidence must be valid UTF-8.", 400);
          }
          if (text.trim() === "") {
            throw new CodeRouteRejected("Code evidence cannot be empty.", 400);
          }
          return jsonResponse(
            decodeCodeEvidenceReference(
              await dependencies.service.stageEvidence(authenticatedWindowId, threadId, text),
            ),
            200,
            origin,
          );
        }
        case "evidence-batch": {
          requireMethodAndEmptyQuery(request, url, "POST");
          requireJsonContentType(request);
          if (dependencies.service.readOperationContents === undefined) {
            return failureResponse(
              { category: "unavailable", message: "Code evidence batch is unavailable." },
              503,
              origin,
            );
          }
          const body = await readBoundedBytes(request, jsonLimit);
          const value = parseJson(body);
          refuseRendererAuthoredIdentity(value);
          let input: CodeEvidenceBatchRequest;
          try {
            input = decodeCodeEvidenceBatchRequest(value);
          } catch {
            throw new CodeRouteRejected("Code evidence batch is invalid.", 400);
          }
          return jsonResponse(
            decodeCodeEvidenceBatchResponse(
              await dependencies.service.readOperationContents(authenticatedWindowId, input),
            ),
            200,
            origin,
          );
        }
        case "attachment": {
          const service = dependencies.service;
          if (
            service.stageAttachment === undefined ||
            service.readAttachment === undefined ||
            service.discardAttachment === undefined
          ) {
            return failureResponse(
              { category: "unavailable", message: "Code attachments are unavailable." },
              503,
              origin,
            );
          }
          if (request.method === "PUT") {
            const upload = readAttachmentUpload(request);
            const bytes = await readBoundedBytes(request, MAX_CODE_ATTACHMENT_BYTES);
            return jsonResponse(
              decodeCodeAttachmentReference(
                await service.stageAttachment(authenticatedWindowId, {
                  ...upload,
                  bytes,
                  signal: request.signal,
                }),
              ),
              200,
              origin,
            );
          }
          if (request.method === "DELETE") {
            // A discard names the pending attachment only; the digest, media
            // type, and length pin reads of journalled bytes, not staging.
            const target = readAttachmentTarget(url);
            await service.discardAttachment(
              authenticatedWindowId,
              target.threadId,
              target.attachmentId,
            );
            return jsonResponse({ status: "discarded" }, 200, origin);
          }
          if (request.method !== "GET") {
            throw new CodeRouteRejected("Code request is invalid.", 400);
          }
          const identity = readAttachmentIdentity(url);
          const bytes = await service.readAttachment(authenticatedWindowId, identity.threadId, {
            attachmentId: identity.attachmentId,
            byteLength: identity.byteLength,
            digest: identity.digest,
          });
          return new Response(Buffer.from(bytes), {
            status: 200,
            headers: {
              ...Object.fromEntries(corsHeaders(origin).entries()),
              "content-type": identity.mediaType,
              "content-length": String(bytes.byteLength),
              // The bytes are pinned by digest, so a cache can keep them.
              "cache-control": "private, max-age=31536000, immutable",
            },
          });
        }
      }
    } catch (error) {
      if (error instanceof CodeRouteRejected) {
        return failureResponse(
          {
            category:
              error.status === 409 ? "stale" : error.status === 503 ? "unavailable" : "invalid",
            message: error.message,
          },
          error.status,
          origin,
        );
      }
      const serviceFailure = serviceFailureFrom(error);
      if (serviceFailure !== undefined) return failureResponse(serviceFailure, origin);
      return failureResponse(
        { category: "unavailable", message: "Octant Code service is unavailable." },
        503,
        origin,
      );
    }
  };
}

type MatchedRoute =
  | Readonly<{
      kind:
        | "bootstrap"
        | "navigation"
        | "commands"
        | "terminal-inspection"
        | "file-save"
        | "file-open"
        | "file-listing"
        | "file-search"
        | "file-watch"
        | "test-listing"
        | "stage-evidence"
        | "evidence-batch"
        | "attachment"
        | "board"
        | "planner-commands"
        | "planner-proposal-commands"
        | "project-pull-requests"
        | "project-pull-requests-refresh"
        | "project-pull-requests-detail"
        | "project-pull-requests-detail-refresh";
    }>
  | Readonly<{ kind: "planner"; projectId: string }>
  | Readonly<{ kind: "thread" | "events" | "conversation" | "follow-up"; threadId: string }>
  | Readonly<{ kind: "operation-events"; threadId: string; operationId: string }>
  | Readonly<{
      kind: "operation-content";
      threadId: string;
      operationId: string;
      contentId: string;
    }>
  | Readonly<{ kind: "content"; contentId: string }>;

/**
 * The identity headers one attachment upload carries. The body is the image;
 * everything that names it travels beside the body so the request never has to
 * be parsed as a document before its bytes are bounded.
 */
function readAttachmentUpload(request: Request): {
  readonly threadId: CodeThreadId;
  readonly attachmentId: CodeAttachmentId;
  readonly displayName: string;
  readonly mediaType: CodeAttachmentMediaType;
} {
  const threadHeader = request.headers.get("x-octant-code-thread-id");
  if (threadHeader === null || threadHeader.trim() === "") {
    throw new CodeRouteRejected("Code attachment requires a thread identity.", 400);
  }
  const attachmentHeader = request.headers.get("x-octant-code-attachment-id");
  if (attachmentHeader === null || attachmentHeader.trim() === "") {
    throw new CodeRouteRejected("Code attachment requires an attachment identity.", 400);
  }
  const encodedDisplayName = request.headers.get("x-octant-code-display-name");
  if (encodedDisplayName === null || encodedDisplayName.trim() === "") {
    throw new CodeRouteRejected("Code attachment requires a display name.", 400);
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  let displayName: string;
  try {
    displayName = decodeURIComponent(encodedDisplayName);
  } catch {
    throw new CodeRouteRejected("Code attachment display name is invalid.", 400);
  }
  try {
    return {
      threadId: decodeCodeThreadId(threadHeader),
      attachmentId: decodeCodeAttachmentId(attachmentHeader),
      displayName,
      mediaType: decodeCodeAttachmentMediaType(mediaType),
    };
  } catch {
    throw new CodeRouteRejected("Code attachment metadata is invalid.", 400);
  }
}

/**
 * Reading or discarding names the attachment, and reading also states the size
 * and digest the journal recorded for it. Nothing about the file is trusted
 * from disk alone.
 */
function readAttachmentTarget(url: URL): {
  readonly threadId: CodeThreadId;
  readonly attachmentId: CodeAttachmentId;
} {
  try {
    return {
      threadId: decodeCodeThreadId(url.searchParams.get("thread") ?? ""),
      attachmentId: decodeCodeAttachmentId(url.searchParams.get("attachment") ?? ""),
    };
  } catch {
    throw new CodeRouteRejected("Code attachment reference is invalid.", 400);
  }
}

function readAttachmentIdentity(url: URL): {
  readonly threadId: CodeThreadId;
  readonly attachmentId: CodeAttachmentId;
  readonly mediaType: CodeAttachmentMediaType;
  readonly byteLength: number;
  readonly digest: string;
} {
  const byteLength = Number(url.searchParams.get("byteLength") ?? "");
  const digest = url.searchParams.get("digest") ?? "";
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > MAX_CODE_ATTACHMENT_BYTES ||
    !/^[a-f0-9]{64}$/.test(digest)
  ) {
    throw new CodeRouteRejected("Code attachment reference is invalid.", 400);
  }
  const target = readAttachmentTarget(url);
  try {
    return {
      ...target,
      mediaType: decodeCodeAttachmentMediaType(url.searchParams.get("mediaType") ?? ""),
      byteLength,
      digest,
    };
  } catch {
    throw new CodeRouteRejected("Code attachment reference is invalid.", 400);
  }
}

function matchRoute(pathname: string): MatchedRoute | undefined {
  if (pathname === "/api/code/bootstrap") return { kind: "bootstrap" };
  if (pathname === "/api/code/navigation") return { kind: "navigation" };
  if (pathname === "/api/code/commands") return { kind: "commands" };
  if (pathname === "/api/code/terminals/inspect") return { kind: "terminal-inspection" };
  if (pathname === "/api/code/board") return { kind: "board" };
  if (pathname === "/api/code/planner/commands") return { kind: "planner-commands" };
  if (pathname === "/api/code/planner/proposals/commands") {
    return { kind: "planner-proposal-commands" };
  }
  const planner = /^\/api\/code\/planner\/([^/]+)$/.exec(pathname);
  if (planner !== null) return { kind: "planner", projectId: planner[1]! };
  if (pathname === "/api/code/project-pull-requests") return { kind: "project-pull-requests" };
  if (pathname === "/api/code/project-pull-requests/refresh") {
    return { kind: "project-pull-requests-refresh" };
  }
  if (pathname === "/api/code/project-pull-requests/detail") {
    return { kind: "project-pull-requests-detail" };
  }
  if (pathname === "/api/code/project-pull-requests/detail/refresh") {
    return { kind: "project-pull-requests-detail-refresh" };
  }
  if (pathname === "/api/code/files/content") return { kind: "file-save" };
  if (pathname === "/api/code/files/open") return { kind: "file-open" };
  if (pathname === "/api/code/files/listing") return { kind: "file-listing" };
  if (pathname === "/api/code/files/search") return { kind: "file-search" };
  if (pathname === "/api/code/files/watch") return { kind: "file-watch" };
  if (pathname === "/api/code/tests/listing") return { kind: "test-listing" };
  if (pathname === "/api/code/evidence") return { kind: "stage-evidence" };
  if (pathname === "/api/code/evidence/batch") return { kind: "evidence-batch" };
  if (pathname === "/api/code/attachments") return { kind: "attachment" };
  const thread = /^\/api\/code\/threads\/([^/]+)$/.exec(pathname);
  if (thread !== null) return { kind: "thread", threadId: thread[1]! };
  const events = /^\/api\/code\/threads\/([^/]+)\/events$/.exec(pathname);
  if (events !== null) return { kind: "events", threadId: events[1]! };
  const conversation = /^\/api\/code\/threads\/([^/]+)\/conversation$/.exec(pathname);
  if (conversation !== null) return { kind: "conversation", threadId: conversation[1]! };
  const followUp = /^\/api\/code\/threads\/([^/]+)\/follow-up$/.exec(pathname);
  if (followUp !== null) return { kind: "follow-up", threadId: followUp[1]! };
  const operationEvents = /^\/api\/code\/threads\/([^/]+)\/operations\/([^/]+)\/events$/.exec(
    pathname,
  );
  if (operationEvents !== null) {
    return {
      kind: "operation-events",
      threadId: operationEvents[1]!,
      operationId: operationEvents[2]!,
    };
  }
  const operationContent =
    /^\/api\/code\/threads\/([^/]+)\/operations\/([^/]+)\/evidence\/([^/]+)$/.exec(pathname);
  if (operationContent !== null) {
    return {
      kind: "operation-content",
      threadId: operationContent[1]!,
      operationId: operationContent[2]!,
      contentId: operationContent[3]!,
    };
  }
  const content = /^\/api\/code\/content\/([^/]+)$/.exec(pathname);
  return content === null ? undefined : { kind: "content", contentId: content[1]! };
}

function contentResponse(content: CodeContentRead, origin: string | null): Response {
  if (
    !(content.bytes instanceof Uint8Array) ||
    content.byteLength !== content.bytes.byteLength ||
    !Number.isSafeInteger(content.byteLength) ||
    content.byteLength < 0 ||
    content.byteLength > MAX_CODE_OPERATION_EVIDENCE_BYTES
  ) {
    throw new CodeRouteRejected("Code content is unavailable.", 503);
  }
  const contentDigest = decodeDigest(content.digest);
  return new Response(Buffer.from(content.bytes), {
    status: 200,
    headers: {
      ...Object.fromEntries(corsHeaders(origin).entries()),
      "content-type": "application/octet-stream",
      "content-length": String(content.byteLength),
      "x-octant-content-length": String(content.byteLength),
      "x-octant-content-digest": contentDigest,
      "access-control-expose-headers": "x-octant-content-length, x-octant-content-digest",
    },
  });
}

function decodePathThreadId(value: string): CodeThreadId {
  try {
    return decodeCodeThreadId(decodeURIComponent(value));
  } catch {
    throw new CodeRouteRejected("Code thread ID is invalid.", 400);
  }
}

function decodePathOperationId(value: string): CodeOperationId {
  try {
    return decodeCodeOperationId(decodeURIComponent(value));
  } catch {
    throw new CodeRouteRejected("Code operation ID is invalid.", 400);
  }
}

function decodePathContentId(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!UUID_PATTERN.test(decoded)) throw new Error("invalid content id");
    return decodeContentId(decoded);
  } catch {
    throw new CodeRouteRejected("Code content ID is invalid.", 400);
  }
}

function decodeReplayCursor(url: URL): number {
  const value = url.searchParams.get("afterSequence");
  if (value === null || url.searchParams.size !== 1 || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new CodeRouteRejected("Code replay cursor is invalid.", 400);
  }
  try {
    return decodeGlobalSequence(Number(value));
  } catch {
    throw new CodeRouteRejected("Code replay cursor is invalid.", 400);
  }
}

function decodeOperationReplayCursor(url: URL): number {
  const value = url.searchParams.get("afterCursor");
  if (value === null || url.searchParams.size !== 1 || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new CodeRouteRejected("Code operation replay cursor is invalid.", 400);
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) {
    throw new CodeRouteRejected("Code operation replay cursor is invalid.", 400);
  }
  return cursor;
}

function decodeConversationPageQuery(url: URL): {
  readonly afterCursor: number;
  readonly limit: number;
} {
  const after = url.searchParams.get("afterCursor");
  const requestedLimit = url.searchParams.get("limit");
  if (
    url.searchParams.size !== 2 ||
    after === null ||
    requestedLimit === null ||
    !/^(?:0|[1-9]\d*)$/.test(after) ||
    !/^[1-9]\d*$/.test(requestedLimit)
  ) {
    throw new CodeRouteRejected("Code conversation cursor is invalid.", 400);
  }
  const afterCursor = Number(after);
  const limit = Number(requestedLimit);
  if (
    !Number.isSafeInteger(afterCursor) ||
    !Number.isSafeInteger(limit) ||
    limit > MAX_CODE_CONVERSATION_PAGE_SIZE
  ) {
    throw new CodeRouteRejected("Code conversation cursor is invalid.", 400);
  }
  return { afterCursor, limit };
}

/**
 * Decode a listing query. The directory is optional and, when present, must
 * round-trip its own percent-encoding: a non-canonical encoding is rejected
 * rather than normalized, so the path the authority confines is exactly the
 * path the caller asked for.
 */
function decodeFileListingQuery(url: URL): Omit<CodeFileListingInput, "signal"> {
  const threadId = url.searchParams.get("threadId");
  const checkoutId = url.searchParams.get("checkoutId");
  const directory = url.searchParams.get("directory");
  if (
    threadId === null ||
    checkoutId === null ||
    url.searchParams.size > (directory === null ? 2 : 3)
  ) {
    throw new CodeRouteRejected("Code file listing query is invalid.", 400);
  }
  try {
    return {
      threadId: decodeCodeThreadId(threadId),
      checkoutId: decodeCheckoutId(checkoutId),
      ...(directory === null ? {} : { directory: decodeCodeRelativePath(directory) }),
    };
  } catch {
    throw new CodeRouteRejected("Code file listing query is invalid.", 400);
  }
}

/**
 * Decode a search query. The scope is explicit rather than inferred from the
 * text, so "look for a file called x" and "look for x inside files" can never
 * be confused for one another by a client that guessed.
 */
function decodeFileSearchQuery(url: URL): Omit<CodeSearchFilesInput, "signal"> {
  const threadId = url.searchParams.get("threadId");
  const checkoutId = url.searchParams.get("checkoutId");
  const scope = url.searchParams.get("scope");
  const query = url.searchParams.get("query");
  if (
    threadId === null ||
    checkoutId === null ||
    query === null ||
    (scope !== "path" && scope !== "content") ||
    query.length > MAX_CODE_SEARCH_QUERY_LENGTH ||
    url.searchParams.size > 4
  ) {
    throw new CodeRouteRejected("Code search query is invalid.", 400);
  }
  try {
    return {
      threadId: decodeCodeThreadId(threadId),
      checkoutId: decodeCheckoutId(checkoutId),
      scope,
      query,
    };
  } catch {
    throw new CodeRouteRejected("Code search query is invalid.", 400);
  }
}

/** Decode a watch query. A watch is scoped to the whole checkout, so it names
 * only the thread and its checkout — there is no directory to narrow. */
function decodeFileWatchQuery(url: URL): Omit<CodeFileWatchInput, "signal"> {
  const threadId = url.searchParams.get("threadId");
  const checkoutId = url.searchParams.get("checkoutId");
  if (threadId === null || checkoutId === null || url.searchParams.size > 2) {
    throw new CodeRouteRejected("Code file watch query is invalid.", 400);
  }
  try {
    return {
      threadId: decodeCodeThreadId(threadId),
      checkoutId: decodeCheckoutId(checkoutId),
    };
  } catch {
    throw new CodeRouteRejected("Code file watch query is invalid.", 400);
  }
}

/**
 * Decode an open query. The path is required and, exactly like the listing's
 * directory, must survive the strict relative-path contract: the path the
 * authority confines is exactly the path the caller asked for.
 */
function decodeFileOpenQuery(url: URL): Omit<CodeFileOpenInput, "signal"> {
  const threadId = url.searchParams.get("threadId");
  const checkoutId = url.searchParams.get("checkoutId");
  const path = url.searchParams.get("path");
  if (threadId === null || checkoutId === null || path === null || url.searchParams.size !== 3) {
    throw new CodeRouteRejected("Code file open query is invalid.", 400);
  }
  try {
    return {
      threadId: decodeCodeThreadId(threadId),
      checkoutId: decodeCheckoutId(checkoutId),
      relativePath: decodeCodeRelativePath(path),
    };
  } catch {
    throw new CodeRouteRejected("Code file open query is invalid.", 400);
  }
}

/**
 * Decode a test listing query. Discovery is scoped to the whole checkout, so
 * the query carries thread and checkout identity and nothing else; an extra
 * parameter is rejected rather than ignored.
 */
function decodeTestListingQuery(url: URL): CodeTestListingInput {
  const threadId = url.searchParams.get("threadId");
  const checkoutId = url.searchParams.get("checkoutId");
  if (threadId === null || checkoutId === null || url.searchParams.size !== 2) {
    throw new CodeRouteRejected("Code repository test listing query is invalid.", 400);
  }
  try {
    return { threadId: decodeCodeThreadId(threadId), checkoutId: decodeCheckoutId(checkoutId) };
  } catch {
    throw new CodeRouteRejected("Code repository test listing query is invalid.", 400);
  }
}

function decodeFileSaveHeaders(headers: Headers): Omit<CodeFileSaveInput, "text"> {
  try {
    const encodedPath = requiredHeader(headers, "x-octant-code-relative-path");
    const relativePath = decodeURIComponent(encodedPath);
    if (encodeURIComponent(relativePath) !== encodedPath) throw new Error("non-canonical path");
    return {
      threadId: decodeCodeThreadId(requiredHeader(headers, "x-octant-code-thread-id")),
      checkoutId: decodeCheckoutId(requiredHeader(headers, "x-octant-code-checkout-id")),
      relativePath: decodeCodeRelativePath(relativePath),
      expectedIdentity: {
        device: boundedIdentity(requiredHeader(headers, "x-octant-code-file-device")),
        inode: boundedIdentity(requiredHeader(headers, "x-octant-code-file-inode")),
      },
      expectedDigest: decodeDigest(requiredHeader(headers, "x-octant-code-expected-digest")),
    };
  } catch {
    throw new CodeRouteRejected("Code file metadata is invalid.", 400);
  }
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null || value === "") throw new Error("missing header");
  return value;
}

function boundedIdentity(value: string): string {
  if (value.length > 128 || value.trim() !== value || value.includes("\0")) {
    throw new Error("invalid identity");
  }
  return value;
}

function requireMethodAndEmptyQuery(request: Request, url: URL, method: string): void {
  if (request.method !== method || url.search !== "") {
    throw new CodeRouteRejected("Code request is invalid.", 400);
  }
}

function requireJsonContentType(request: Request): void {
  if (request.headers.get("content-type")?.trim().toLowerCase() !== "application/json") {
    throw new CodeRouteRejected("Code command content type is invalid.", 400);
  }
}

function requireTextContentType(request: Request): void {
  const value = request.headers.get("content-type")?.trim().toLowerCase() ?? "";
  if (!/^text\/plain;\s*charset=utf-8$/.test(value)) {
    throw new CodeRouteRejected("Code file content type is invalid.", 400);
  }
}

async function readBoundedBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new CodeRouteRejected("Content length is invalid.", 400);
    if (BigInt(declared) > BigInt(maximumBytes)) {
      throw new CodeRouteRejected("Request body is too large.", 413);
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new CodeRouteRejected("Request body is too large.", 413);
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = fatalUtf8.decode(bytes);
  } catch {
    throw new CodeRouteRejected("Command body must be valid UTF-8 JSON.", 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CodeRouteRejected("Command body must be valid JSON.", 400);
  }
}

function ndjsonResponse(
  frames: ReadonlyArray<CodeEventFrame | CodeOperationStreamFrame>,
  origin: string | null,
): Response {
  const body = frames.map(serializeNdjsonFrame).join("");
  return new Response(body, {
    status: 200,
    headers: {
      ...Object.fromEntries(corsHeaders(origin).entries()),
      "content-type": "application/x-ndjson",
    },
  });
}

/**
 * Stream change notices as NDJSON for as long as the client stays connected.
 *
 * Unlike replay, a watch has no last frame, so the body is produced lazily
 * rather than collected first. That also means a failure after the first byte
 * can no longer become a status code: the stream simply ends, and the client
 * reconnects into a fresh authorization rather than being told a half-truth.
 */
function noticeStreamResponse(
  notices: AsyncIterable<CodeFileChangeNotice>,
  signal: AbortSignal,
  origin: string | null,
): Response {
  const encoder = new TextEncoder();
  const iterator = notices[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          if (signal.aborted) {
            controller.close();
            return;
          }
          const next = await iterator.next();
          if (next.done === true) {
            controller.close();
            return;
          }
          const line = serializeNoticeLine(next.value);
          if (line === undefined) continue;
          controller.enqueue(encoder.encode(line));
          return;
        }
      } catch {
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      ...Object.fromEntries(corsHeaders(origin).entries()),
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    },
  });
}

/**
 * One notice as a line, or the same notice reduced to "everything changed"
 * when naming the paths would exceed the line budget. A notice is never
 * dropped for being large: losing it would leave the surface silently stale.
 */
function serializeNoticeLine(notice: CodeFileChangeNotice): string | undefined {
  try {
    const line = `${JSON.stringify(decodeCodeFileChangeNotice(notice))}\n`;
    if (Buffer.byteLength(line, "utf8") <= MAX_CODE_NDJSON_LINE_BYTES) return line;
    const reduced = decodeCodeFileChangeNotice({ ...notice, paths: [], truncated: true });
    return `${JSON.stringify(reduced)}\n`;
  } catch {
    return undefined;
  }
}

function serializeNdjsonFrame(frame: CodeEventFrame | CodeOperationStreamFrame): string {
  const decoded =
    "operationId" in frame ? decodeCodeOperationStreamFrame(frame) : decodeCodeEventFrame(frame);
  const line = `${JSON.stringify(decoded)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_CODE_NDJSON_LINE_BYTES) {
    throw new CodeRouteRejected("Code replay frame is too large.", 400);
  }
  return line;
}

function serviceFailureFrom(error: unknown): CodeFailure | undefined {
  if (!isRecord(error) || !("failure" in error)) return undefined;
  try {
    return decodeCodeFailure(error.failure);
  } catch {
    return undefined;
  }
}

function failureResponse(failure: CodeFailure, origin: string | null): Response;
function failureResponse(failure: CodeFailure, status: number, origin: string | null): Response;
function failureResponse(
  failure: CodeFailure,
  statusOrOrigin: number | string | null,
  maybeOrigin?: string | null,
): Response {
  const status =
    typeof statusOrOrigin === "number"
      ? statusOrOrigin
      : failure.category === "unauthorized"
        ? 401
        : failure.category === "stale" || failure.category === "conflict"
          ? 409
          : failure.category === "unavailable" || failure.category === "waiting"
            ? 503
            : failure.category === "disconnected"
              ? 502
              : 400;
  const origin = typeof statusOrOrigin === "number" ? (maybeOrigin ?? null) : statusOrOrigin;
  return jsonResponse(decodeCodeFailure(failure), status, origin);
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function isAllowedOrigin(origin: string): boolean {
  if (origin === "file://") return true;
  try {
    const url = new URL(origin);
    return (
      origin === url.origin &&
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

function publicMessage(error: unknown, fallback: string): string {
  return error instanceof CodeRouteRejected ? error.message : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function refuseRendererAuthoredIdentity(value: unknown): void {
  if (!isRecord(value)) return;
  if (Object.prototype.hasOwnProperty.call(value, "windowId")) {
    throw new CodeRouteRejected("Code requests cannot supply window identity.", 400);
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "owner") ||
    Object.prototype.hasOwnProperty.call(value, "name") ||
    Object.prototype.hasOwnProperty.call(value, "root") ||
    Object.prototype.hasOwnProperty.call(value, "credentials")
  ) {
    throw new CodeRouteRejected("Code requests cannot supply repository identity.", 400);
  }
}

class CodeRouteRejected extends Error {
  override readonly name = "CodeRouteRejected";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
