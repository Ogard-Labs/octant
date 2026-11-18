/** Public system toolchains required to execute a command beneath a root read
 * deny. No account/home directory is included; writes remain Project-scoped. */
export function claudeSandboxToolchainReads(
  platform: string = process.platform,
): ReadonlyArray<string> {
  return platform === "darwin"
    ? [
        "/usr",
        "/bin",
        "/sbin",
        "/System/Library",
        "/Library/Developer",
        "/dev",
        "/private/var/db/dyld",
        "/private/etc/hosts",
        "/private/etc/resolv.conf",
        "/private/etc/ssl",
      ]
    : platform === "linux"
      ? [
          "/usr",
          "/bin",
          "/lib",
          "/lib64",
          "/dev",
          "/etc/ld.so.cache",
          "/etc/passwd",
          "/etc/group",
          "/etc/nsswitch.conf",
          "/etc/hosts",
          "/etc/resolv.conf",
          "/etc/ssl",
        ]
      : [];
}
