import type { WindowsAuthorityStateFile } from "@octant/host-runtime";

const unavailable = () => new Error("The private authority state is unavailable or unsafe.");

/** Keep schema ownership in each store; only positively missing native records use its default. */
export function nativeAuthorityState<State>(
  dataDirectory: string,
  file: WindowsAuthorityStateFile | undefined,
  decode: (value: unknown) => State,
  encode: (state: State) => unknown,
  empty: () => State,
): { readonly load: () => State; readonly save: (state: State) => void } | undefined {
  if (file === undefined && process.platform !== "win32") return undefined;
  const load = (): State => {
    if (file === undefined || file.dataDirectory !== dataDirectory) throw unavailable();
    const reading = file.read();
    if (reading.status === "missing") return empty();
    if (reading.status !== "ready") throw unavailable();
    try {
      return decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reading.bytes)));
    } catch {
      throw unavailable();
    } finally {
      reading.bytes.fill(0);
    }
  };
  return {
    load,
    save: (state) => {
      // A save must not silently replace corrupt or exposed authority state.
      load();
      if (file === undefined) throw unavailable();
      let bytes: Buffer | undefined;
      try {
        bytes = Buffer.from(JSON.stringify(encode(state)), "utf8");
        if (file.replace(bytes).status !== "committed") throw unavailable();
      } catch {
        throw unavailable();
      } finally {
        bytes?.fill(0);
      }
    },
  };
}
