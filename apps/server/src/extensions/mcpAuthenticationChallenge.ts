/**
 * Where sign-in discovery will read resource metadata from: https without
 * credentials in the address, or plain http on this computer.
 */
export function readableMetadataAddress(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return !url.username && !url.password;
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/;
const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*/;

/**
 * The `resource_metadata` parameter (RFC 9728) of the Bearer challenge in a
 * `WWW-Authenticate` header, read by the challenge grammar of RFC 9110 §11.6.1:
 * one header may hold several challenges, and a parameter belongs only to the
 * challenge it follows. The first address discovery will read counts: a bare
 * word is no place to start a sign-in from. Both the connection's refusal and
 * sign-in discovery read the header through this, so they never disagree
 * about what a server offered.
 */
export function bearerResourceMetadata(header: string | null): string | undefined {
  if (header === null) return undefined;
  let rest = header;
  let scheme: string | undefined;
  const skip = (pattern: RegExp) => {
    rest = rest.replace(pattern, "");
  };
  while (rest.length > 0) {
    skip(/^[\s,]+/);
    const token = TOKEN.exec(rest)?.[0];
    if (token === undefined) {
      // Not a token: skip to the next list element rather than misread it.
      const comma = rest.indexOf(",");
      if (comma === -1) return undefined;
      rest = rest.slice(comma);
      continue;
    }
    const afterToken = rest.slice(token.length);
    const assignment = /^[ \t]*=[ \t]*/.exec(afterToken);
    if (scheme === undefined || assignment === null || /^=*[ \t]*(?:,|$)/.test(afterToken)) {
      // A token not followed by `=` and a value starts a new challenge.
      scheme = token.toLowerCase();
      rest = afterToken;
      skip(/^[ \t]+/);
      const token68 = TOKEN68.exec(rest)?.[0];
      if (token68 !== undefined && /^[ \t]*(?:,|$)/.test(rest.slice(token68.length)))
        rest = rest.slice(token68.length);
      continue;
    }
    rest = afterToken.slice(assignment[0].length);
    let value: string;
    if (rest.startsWith('"')) {
      const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
      if (quoted === null) return undefined;
      value = (quoted[1] ?? "").replace(/\\(.)/g, "$1");
      rest = rest.slice(quoted[0].length);
    } else {
      const bare = TOKEN.exec(rest)?.[0];
      if (bare === undefined) return undefined;
      value = bare;
      rest = rest.slice(bare.length);
    }
    // A value runs to the next list element; anything else (an unquoted URL)
    // is not the grammar, and a misread value would name the wrong address.
    if (!/^[ \t]*(?:,|$)/.test(rest)) return undefined;
    // An unreadable address in one Bearer challenge does not void a readable
    // one in a later challenge of the same header.
    if (
      scheme === "bearer" &&
      token.toLowerCase() === "resource_metadata" &&
      readableMetadataAddress(value)
    )
      return value;
  }
  return undefined;
}
