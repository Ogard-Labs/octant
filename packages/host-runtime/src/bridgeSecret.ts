import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostRuntimePaths } from "./paths";

export async function writeBridgeSecretProjection(
  paths: HostRuntimePaths,
  secret: string,
): Promise<void> {
  const directory = dirname(paths.bridgeSecretPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.bridge-secret-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${secret}\n`, { encoding: "utf8" });
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporary, paths.bridgeSecretPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}
