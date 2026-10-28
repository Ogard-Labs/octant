import type { ServiceCommandRunner } from "./serviceManager";

export type DiskEncryption = "encrypted" | "not-encrypted" | "unknown";

/**
 * Whether the disk holding the data folder is encrypted. The hub keeps its keys
 * in a file there so it can serve before anyone logs in, which is only as safe
 * as the disk. A reading that cannot be made is `unknown`, never a guess.
 */
export async function readDiskEncryption(input: {
  readonly platform: NodeJS.Platform;
  readonly dataDirectory: string;
  readonly runner: ServiceCommandRunner;
}): Promise<DiskEncryption> {
  try {
    if (input.platform === "darwin") {
      const { stdout } = await input.runner.run("/usr/bin/fdesetup", ["status"]);
      if (/FileVault is On/i.test(stdout)) return "encrypted";
      if (/FileVault is Off/i.test(stdout)) return "not-encrypted";
      return "unknown";
    }
    if (input.platform === "linux") {
      const mounted = await input.runner.run("/usr/bin/findmnt", [
        "-n",
        "-o",
        "SOURCE",
        "--target",
        input.dataDirectory,
      ]);
      const device = mounted.stdout.trim().split("\n")[0]?.trim();
      if (device === undefined || !device.startsWith("/dev/")) return "unknown";
      // Lists the device and every device beneath it; a dm-crypt layer shows as `crypt`.
      const layers = await input.runner.run("/usr/bin/lsblk", ["-s", "-n", "-o", "TYPE", device]);
      return layers.stdout.split("\n").some((line) => line.trim() === "crypt")
        ? "encrypted"
        : "not-encrypted";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

/** The warning for a disk that is not known to be encrypted; absent when it is. */
export function diskEncryptionWarning(
  platform: NodeJS.Platform,
  encryption: DiskEncryption,
): string | undefined {
  if (encryption === "encrypted") return undefined;
  const turnOn =
    platform === "darwin"
      ? "Turn on FileVault in System Settings, Privacy & Security."
      : "Encrypt the disk with LUKS.";
  return encryption === "not-encrypted"
    ? `Warning: this computer's disk is not encrypted. The hub keeps its keys in a file in the Octant data folder, so anyone who takes the disk can read them. ${turnOn}`
    : `Warning: Octant could not check whether this computer's disk is encrypted. The hub keeps its keys in a file in the Octant data folder. ${turnOn}`;
}
