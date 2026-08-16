export class SearxngEndpointRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearxngEndpointRejected";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "[::1]";
}

export function validateSearxngEndpoint(value: string): URL {
  const normalized = value.trim();
  if (normalized.includes("?") || normalized.includes("#")) {
    throw new SearxngEndpointRejected(
      "SearXNG base URL cannot include query or fragment delimiters.",
    );
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new SearxngEndpointRejected("SearXNG base URL is invalid.");
  }

  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new SearxngEndpointRejected(
      "SearXNG base URL cannot include credentials, query, or fragment.",
    );
  }

  if (url.protocol === "https:") {
    if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
    }
    return url;
  }

  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
    }
    return url;
  }

  throw new SearxngEndpointRejected("SearXNG base URL must use HTTPS or loopback HTTP.");
}

export function validateSearxngRedirectTarget(url: URL): URL {
  if (url.username !== "" || url.password !== "") {
    throw new SearxngEndpointRejected("SearXNG redirect cannot include credentials.");
  }
  if (url.hash !== "") {
    throw new SearxngEndpointRejected("SearXNG redirect cannot include a fragment.");
  }
  if (url.protocol === "https:") {
    return url;
  }
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    return url;
  }
  throw new SearxngEndpointRejected("SearXNG redirect must use HTTPS or loopback HTTP.");
}
