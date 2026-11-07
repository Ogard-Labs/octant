/** One lease's bounded HTTP/WebSocket path; no host socket or general fetch capability. */
export interface DesktopPreviewRequest {
  readonly method: string;
  readonly pathQuery: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body?: Uint8Array;
  readonly signal: AbortSignal;
}

export interface DesktopPreviewMessage {
  readonly text: boolean;
  readonly data: Uint8Array;
}

export interface DesktopPreviewPeer {
  readonly send: (message: DesktopPreviewMessage) => void;
  readonly close: (code: number, reason: string) => void;
}

export interface DesktopPreviewPeerEvents {
  readonly message: (message: DesktopPreviewMessage) => void;
  readonly closed: (code: number, reason: string) => void;
}

export type DesktopPreviewUpgrade =
  | {
      readonly status: "opened";
      readonly protocol?: string;
      readonly open: (peer: DesktopPreviewPeer) => DesktopPreviewPeerEvents;
      readonly cancel: () => void;
    }
  | { readonly status: "refused" };

/** The host binds both operations to the approved process and port before giving this port out. */
export interface DesktopPreviewRelay {
  readonly request: (input: DesktopPreviewRequest) => Promise<Response>;
  readonly upgrade: (
    input: Omit<DesktopPreviewRequest, "method" | "body">,
  ) => Promise<DesktopPreviewUpgrade>;
}

export interface DesktopPreviewOpening {
  readonly grantId: string;
  readonly port: number;
  readonly expiresAt: string;
  readonly relay: DesktopPreviewRelay;
  readonly signal: AbortSignal;
}

export type DesktopPreviewOpened =
  | {
      readonly status: "ready";
      /** Loopback inside this one guest, never a host or public listener. */
      readonly guestUrl: string;
      readonly close: () => Promise<"closed" | "unconfirmed">;
    }
  | {
      readonly status: "unavailable";
      /** A failed start retains ownership until its possible guest process is confirmed stopped. */
      readonly close?: () => Promise<"closed" | "unconfirmed">;
    };

/** A host-local driver receives only a basename in its own home and an invocation-local proof. */
export type DesktopPreviewPrepared =
  | {
      readonly status: "prepared";
      readonly socketName: string;
      readonly nonce: string;
      readonly close: () => Promise<void>;
    }
  | { readonly status: "unavailable" };
