import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ParseResult } from "effect";
import {
  decodeComputerControlCommand,
  decodeComputerUseOwner,
  decodeComputerUseSettings,
} from "@octant/contracts/computer-use-plugin";
import type { ComputerUseDesktopService } from "./computerUseDesktopService";

const HEADER = "x-octant-computer-use-token";
const MAX_BODY_BYTES = 128 * 1024;
const failure = (status: number) =>
  Response.json({ error: "computer-use-broker-refused" }, { status });

export function computerUseBrokerHandler(service: ComputerUseDesktopService, token: string) {
  return async (request: Request, peer = "127.0.0.1"): Promise<Response> => {
    const supplied = Buffer.from(request.headers.get(HEADER) ?? "");
    const expected = Buffer.from(token);
    if (
      (peer !== "127.0.0.1" && peer !== "::ffff:127.0.0.1") ||
      request.headers.has("origin") ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return failure(401);
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/computer-use" || url.search !== "")
      return failure(400);
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES) return failure(413);
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof body !== "object" || body === null || !("operation" in body)) return failure(400);
      if (body.operation === "status") return Response.json(await service.status());
      if (body.operation === "configure" && "settings" in body) {
        await service.configure(decodeComputerUseSettings(body.settings));
        return Response.json({ ok: true });
      }
      if (!("owner" in body)) return failure(400);
      const owner = decodeComputerUseOwner(body.owner);
      if (body.operation === "reserve")
        return Response.json({ reserved: await service.reserve(owner) });
      if (body.operation === "release") {
        await service.release(owner);
        return Response.json({ released: true });
      }
      if (body.operation === "execute" && "command" in body)
        return Response.json(
          await service.execute(owner, decodeComputerControlCommand(body.command), request.signal),
        );
      return failure(400);
    } catch (error) {
      return failure(ParseResult.isParseError(error) || error instanceof SyntaxError ? 400 : 503);
    }
  };
}

async function readBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) return undefined;
    length += chunk.byteLength;
    if (length > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

export async function startComputerUseBroker(service: ComputerUseDesktopService) {
  const token = randomBytes(32).toString("base64url");
  const handle = computerUseBrokerHandler(service, token);
  const server = createServer((incoming, outgoing) => {
    const controller = new AbortController();
    incoming.once("aborted", () => controller.abort());
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) controller.abort();
    });
    void (async () => {
      const body = await readBody(incoming);
      if (body === undefined) return failure(413);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(","));
      }
      return handle(
        new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
          method: incoming.method ?? "POST",
          headers,
          signal: controller.signal,
          ...(incoming.method === "GET" || incoming.method === "HEAD"
            ? {}
            : { body: Buffer.from(body) }),
        }),
        incoming.socket.remoteAddress ?? "",
      );
    })().then(
      async (response) => {
        outgoing.writeHead(response.status, { "content-type": "application/json" });
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      },
      () => {
        outgoing.writeHead(503);
        outgoing.end();
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Computer-use broker did not bind.");
  return {
    token,
    url: `http://127.0.0.1:${address.port}/v1/computer-use`,
    close: async () => {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}
export type ComputerUseBroker = Awaited<ReturnType<typeof startComputerUseBroker>>;
