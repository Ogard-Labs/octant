import { Schema } from "effect";
import type { SshExecutorIdentityFacts } from "@octant/contracts/ssh-target";
import {
  SshExecutorHostFrame,
  type SshExecutorDialFrame,
  type SshExecutorFrame,
  type SshExecutorReply,
  type SshExecutorRequest,
  type SshExecutorResolveFrame,
  type SshExecutorStreamFrame,
} from "@octant/contracts/ssh-executor-protocol";
import { encodeExecutorFrame, ExecutorFrameReader, executorPreamble } from "./executorFrames";

/**
 * The executor's half of one SSH session: introduce itself, then answer the
 * host's requests until its input closes. Canonical:
 * docs/design/remote-ssh-environments.md § Transport.
 *
 * It acts only on a frame that decodes against the host frame schema, does
 * nothing on its own initiative, and ends the session on the first frame it
 * cannot read, because a stream that lost its framing cannot be trusted.
 * Requests run one at a time; a `cancel` stops the one in flight. The frames
 * of a running command's egress go to its handler, which ends the session on
 * one that breaks the protocol.
 */

export type ExecutorEgressFrame =
  | SshExecutorDialFrame
  | SshExecutorResolveFrame
  | SshExecutorStreamFrame;

export interface SshExecutorSessionHandlers {
  /** Answers one request: the attestation, a read, a file tool, or a command. */
  readonly answer: (request: SshExecutorRequest, signal: AbortSignal) => Promise<SshExecutorReply>;
  /** A frame of a running command's egress; `violated` ends the session. */
  readonly receive: (frame: ExecutorEgressFrame) => "accepted" | "violated";
  /** The session is over; nothing more arrives or leaves. */
  readonly end: () => void;
}

export interface SshExecutorSessionOptions {
  readonly input: AsyncIterable<Uint8Array | string>;
  readonly write: (bytes: Uint8Array) => void;
  readonly identity: SshExecutorIdentityFacts;
  /** The session's handlers, given the way to send a frame to the host. */
  readonly handlers: (send: (frame: SshExecutorFrame) => void) => SshExecutorSessionHandlers;
}

export type SshExecutorSessionEnd = "input-closed" | "protocol-violated";

const decodeHostFrame = Schema.decodeUnknownEither(SshExecutorHostFrame);

export async function serveSshExecutor(
  options: SshExecutorSessionOptions,
): Promise<SshExecutorSessionEnd> {
  let open = true;
  const send = (frame: SshExecutorFrame) => {
    if (!open) return;
    const encoded = encodeExecutorFrame(frame);
    if (encoded.status === "encoded") {
      options.write(encoded.bytes);
      return;
    }
    // A reply past the frame bound, such as a diff of control characters
    // whose JSON escapes outgrew it, is answered as too large instead.
    if (frame.type === "reply") {
      send({ type: "reply", id: frame.id, reply: { kind: "refused", reason: "too-large" } });
    }
  };
  options.write(executorPreamble());
  send({ type: "hello", identity: options.identity });
  const handlers = options.handlers(send);

  const reader = new ExecutorFrameReader({ expectPreamble: false });
  let inFlight: { readonly id: number; readonly controller: AbortController } | undefined;
  const finish = (end: SshExecutorSessionEnd): SshExecutorSessionEnd => {
    open = false;
    inFlight?.controller.abort();
    handlers.end();
    return end;
  };
  for await (const chunk of options.input) {
    const reading = reader.push(
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
    );
    if (reading.status === "violated") return finish("protocol-violated");
    for (const value of reading.frames) {
      const decoded = decodeHostFrame(value);
      if (decoded._tag === "Left") return finish("protocol-violated");
      const frame = decoded.right;
      switch (frame.type) {
        case "request": {
          if (inFlight !== undefined) {
            send({ type: "reply", id: frame.id, reply: { kind: "busy" } });
            break;
          }
          const running = { id: frame.id, controller: new AbortController() };
          inFlight = running;
          // A request that fails sends no reply; the host stops waiting for
          // it and ends the connection, which is the honest outcome.
          void handlers
            .answer(frame.request, running.controller.signal)
            .then(
              (reply) => send({ type: "reply", id: running.id, reply }),
              () => undefined,
            )
            .finally(() => {
              if (inFlight === running) inFlight = undefined;
            });
          break;
        }
        case "cancel":
          if (inFlight?.id === frame.id) inFlight.controller.abort();
          break;
        default:
          if (handlers.receive(frame) === "violated") return finish("protocol-violated");
      }
    }
  }
  // The host is gone. Nothing still running is waited for: the process exits
  // and its confined children die with it.
  return finish("input-closed");
}
