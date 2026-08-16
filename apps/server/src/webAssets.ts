import { extname, join, normalize, resolve, sep } from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface WebAssetsFilesystem {
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly stat: (path: string) => Promise<{ isFile(): boolean }>;
}

export interface WebAssetsOptions extends WebAssetsFilesystem {
  readonly distPath: string;
  readonly indexHtml?: string;
}

export function createWebAssetsHandler(options: WebAssetsOptions) {
  const distRoot = resolve(options.distPath);
  const indexHtml = options.indexHtml;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (request.method !== "GET") return undefined;
    if (url.pathname === "/health" || url.pathname.startsWith("/api/")) return undefined;

    const relativePath = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const candidatePath = normalize(join(distRoot, relativePath));
    if (!candidatePath.startsWith(`${distRoot}${sep}`) && candidatePath !== distRoot) {
      return new Response("Not Found", { status: 404 });
    }

    let isFile: boolean;
    try {
      const stats = await options.stat(candidatePath);
      isFile = stats.isFile();
    } catch {
      isFile = false;
    }

    if (isFile) {
      return serveFile(options, candidatePath);
    }

    const hasExtension = extname(relativePath) !== "";
    if (hasExtension) {
      return new Response("Not Found", { status: 404 });
    }

    if (indexHtml !== undefined) {
      return new Response(indexHtml, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const indexPath = join(distRoot, "index.html");
    let indexExists: boolean;
    try {
      const stats = await options.stat(indexPath);
      indexExists = stats.isFile();
    } catch {
      indexExists = false;
    }
    if (!indexExists) {
      return relativePath === ""
        ? webClientUnavailable()
        : new Response("Not Found", { status: 404 });
    }
    return serveFile(options, indexPath);
  };
}

async function serveFile(options: WebAssetsOptions, path: string): Promise<Response> {
  let body: Buffer;
  try {
    body = await options.readFile(path);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": extname(path) === ".html" ? "no-cache" : "public, max-age=3600",
    },
  });
}

function webClientUnavailable(): Response {
  return Response.json(
    {
      product: "Octant",
      status: "unavailable",
      category: "unavailable",
      message:
        "Octant web client is not built. Run `bun run build` and retry, or use `octant web --dev` for the Vite renderer.",
    },
    { status: 503 },
  );
}
