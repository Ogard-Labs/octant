import {
  decodeBrowserCaptureId,
  decodeBrowserThreadId,
  MAX_BROWSER_CAPTURE_BYTES,
  type BrowserCaptureId,
  type BrowserThreadId,
  type ImageArtifactMediaType,
} from "@octant/contracts";
import { ManagedAttachmentStore } from "../attachments/managedAttachmentStore";
import { sniffGeneratedImageMediaType } from "../image/generatedImageStore";

export class BrowserCaptureTooLarge extends Error {
  readonly category = "too-large" as const;

  constructor(readonly byteLength: number) {
    super(
      `Browser capture is too large (${byteLength} bytes). The maximum size is ${MAX_BROWSER_CAPTURE_BYTES} bytes.`,
    );
    this.name = "BrowserCaptureTooLarge";
  }
}

export class BrowserCaptureInvalid extends Error {
  readonly category = "invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "BrowserCaptureInvalid";
  }
}

export interface BrowserCaptureStaged {
  readonly threadId: BrowserThreadId;
  readonly captureId: BrowserCaptureId;
  readonly size: number;
  readonly hash: string;
  readonly stagedAt: string;
}

export interface BrowserCaptureFinalized {
  readonly threadId: BrowserThreadId;
  readonly captureId: BrowserCaptureId;
  readonly size: number;
  readonly hash: string;
  readonly mime: ImageArtifactMediaType;
  readonly finalizedAt: string;
}

/** The store keeps no per-capture name: a capture is identified by its id alone. */
const DISPLAY_NAME = "browser-capture";

/**
 * Bytes of the pictures a thread keeps, one managed-store scope per thread.
 * Staging, digest-checked finalization, and crash recovery live in the shared
 * managed store; this class decodes the browser identities and refuses bytes
 * that are not a recognised image whatever the data URL declared.
 */
export class BrowserCaptureStore {
  readonly #store: ManagedAttachmentStore;

  constructor(dataDirectory: string) {
    this.#store = new ManagedAttachmentStore(dataDirectory, {
      scopesDirectory: "browser-captures",
      maxBytes: MAX_BROWSER_CAPTURE_BYTES,
      decodeScopeId: (value) => String(decodeBrowserThreadId(value)),
      decodeAttachmentId: (value) => String(decodeBrowserCaptureId(value)),
      tooLarge: (byteLength) => new BrowserCaptureTooLarge(byteLength),
      empty: () => new BrowserCaptureInvalid("Browser capture must not be empty."),
      invalidDisplayName: (message) => new BrowserCaptureInvalid(message),
    });
  }

  async stage(input: {
    readonly threadId: BrowserThreadId;
    readonly captureId: BrowserCaptureId;
    readonly bytes: Uint8Array;
  }): Promise<BrowserCaptureStaged> {
    if (input.bytes.length > MAX_BROWSER_CAPTURE_BYTES) {
      throw new BrowserCaptureTooLarge(input.bytes.length);
    }
    if (sniffGeneratedImageMediaType(input.bytes) === undefined) {
      throw new BrowserCaptureInvalid("Browser capture bytes are not a recognized image.");
    }
    const staged = await this.#store.stage({
      scopeId: String(input.threadId),
      attachmentId: String(input.captureId),
      displayName: DISPLAY_NAME,
      bytes: input.bytes,
    });
    return {
      threadId: decodeBrowserThreadId(staged.scopeId),
      captureId: decodeBrowserCaptureId(staged.attachmentId),
      size: staged.size,
      hash: staged.hash,
      stagedAt: staged.stagedAt,
    };
  }

  async finalize(staged: BrowserCaptureStaged): Promise<BrowserCaptureFinalized> {
    const finalized = await this.#store.finalize({
      scopeId: String(staged.threadId),
      attachmentId: String(staged.captureId),
      displayName: DISPLAY_NAME,
      size: staged.size,
      hash: staged.hash,
      stagedAt: staged.stagedAt,
    });
    const bytes = await this.#store.read(finalized);
    const mime = sniffGeneratedImageMediaType(bytes);
    if (mime === undefined) {
      throw new BrowserCaptureInvalid("Finalized browser capture is not a recognized image.");
    }
    return {
      threadId: decodeBrowserThreadId(finalized.scopeId),
      captureId: decodeBrowserCaptureId(finalized.attachmentId),
      size: finalized.size,
      hash: finalized.hash,
      mime,
      finalizedAt: finalized.finalizedAt,
    };
  }

  read(input: {
    readonly threadId: BrowserThreadId;
    readonly captureId: BrowserCaptureId;
    readonly size: number;
    readonly hash: string;
    readonly finalizedAt: string;
  }): Promise<Uint8Array> {
    return this.#store.read({
      scopeId: String(input.threadId),
      attachmentId: String(input.captureId),
      displayName: DISPLAY_NAME,
      size: input.size,
      hash: input.hash,
      finalizedAt: input.finalizedAt,
    });
  }

  remove(threadId: BrowserThreadId, captureId: BrowserCaptureId): Promise<void> {
    return this.#store.remove(String(threadId), String(captureId));
  }

  /** Removes bytes the journal no longer retains and half-written staging left by a crash. */
  recover(isRetained: (threadId: BrowserThreadId, captureId: BrowserCaptureId) => boolean) {
    return this.#store.recover({
      isFinalizedAttachmentReferenced: (scopeId, attachmentId) =>
        isRetained(decodeBrowserThreadId(scopeId), decodeBrowserCaptureId(attachmentId)),
    });
  }

  purgeThread(threadId: BrowserThreadId): Promise<void> {
    return this.#store.purgeScope(String(threadId));
  }
}
