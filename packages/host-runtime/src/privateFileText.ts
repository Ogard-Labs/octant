import type { WindowsAuthorityStateFile } from "./windowsAuthorityState";

/** Decode only admitted bytes; unsafe input is never mistaken for an absent file. */
export function readPrivateFileText(
  file: WindowsAuthorityStateFile,
  maximumBytes: number,
):
  | { readonly status: "ready"; readonly text: string }
  | { readonly status: "missing" | "refused" } {
  try {
    const result = file.read();
    if (result.status !== "ready") return result;
    try {
      return result.bytes.length > maximumBytes
        ? { status: "refused" }
        : { status: "ready", text: new TextDecoder("utf-8", { fatal: true }).decode(result.bytes) };
    } finally {
      result.bytes.fill(0);
    }
  } catch {
    return { status: "refused" };
  }
}

export function replacePrivateFileText(
  file: WindowsAuthorityStateFile,
  text: string,
): { readonly status: "committed" | "refused" } {
  const bytes = Buffer.from(text, "utf8");
  try {
    return file.replace(bytes);
  } catch {
    return { status: "refused" };
  } finally {
    bytes.fill(0);
  }
}
