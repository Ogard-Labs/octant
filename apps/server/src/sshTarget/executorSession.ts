import { Schema } from "effect";
import type { SshExecutorIdentityFacts } from "@octant/contracts/ssh-target";
import {
  SshExecutorHostFrame,
  type SshExecutorFrame,
  type SshExecutorReply,
  type SshExecutorRequest,
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
 */

export interface SshExecutorSessionOptions {
  readonly input: AsyncIterable<Uint8Array | string>;
  readonly write: (bytes: Uint8Array) => void;
  readonly identity: SshExecutorIdentityFacts;
  /** Answers one request: the attestation, or a read of a bound root. */
  readonly answer: (request: SshExecutorRequest) => Promise<SshExecutorReply>;
}

export type SshExecutorSessionEnd = "input-closed" | "protocol-violated";

const decodeHostFrame = Schema.decodeUnknownEither(SshExecutorHostFrame);

export async function serveSshExecutor(
  options: SshExecutorSessionOptions,
): Promise<SshExecutorSessionEnd> {
  const send = (frame: SshExecutorFrame) => {
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

  const reader = new ExecutorFrameReader({ expectPreamble: false });
  let busy = false;
  for await (const chunk of options.input) {
    const reading = reader.push(
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
    );
    if (reading.status === "violated") return "protocol-violated";
    for (const value of reading.frames) {
      const decoded = decodeHostFrame(value);
      if (decoded._tag === "Left") return "protocol-violated";
      const { id, request } = decoded.right;
      if (busy) {
        send({ type: "reply", id, reply: { kind: "busy" } });
        continue;
      }
      busy = true;
      // A request that fails sends no reply; the host stops waiting for it
      // and ends the connection, which is the honest outcome.
      void options
        .answer(request)
        .then(
          (reply) => send({ type: "reply", id, reply }),
          () => undefined,
        )
        .finally(() => {
          busy = false;
        });
    }
  }
  // The host is gone. Nothing still running is waited for: the process exits
  // and its confined children die with it.
  return "input-closed";
}
