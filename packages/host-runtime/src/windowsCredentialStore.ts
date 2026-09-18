import { spawn } from "node:child_process";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";

/**
 * Windows keeps provider credentials in Credential Manager as "generic"
 * credentials — the same shape Git Credential Manager uses — so a credential
 * Octant stores is one the platform protects and the person can see and remove
 * from their own account settings.
 *
 * `cmdkey` handles store, list and delete. It cannot read a secret back, and no
 * other Windows CLI can either, so `resolve` calls the Win32 CredRead API
 * through PowerShell. Both executables are named by absolute path so a PATH
 * entry cannot redirect either one.
 */
export const CMDKEY_PATH = "C:\\Windows\\System32\\cmdkey.exe";
export const POWERSHELL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 16 * 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TARGET_PREFIX = "Octant provider credential ";

/**
 * Reads one generic credential and writes its secret to stdout as UTF-16,
 * which is how Credential Manager stores the blob. `CRED_TYPE_GENERIC` is 1.
 * Exits 3 when the target is absent so the caller can tell "missing" from
 * "the read failed".
 */
const READ_CREDENTIAL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class OctantCred{[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct CRED{public uint Flags;public uint Type;public string TargetName;public string Comment;public long LastWritten;public uint CredentialBlobSize;public IntPtr CredentialBlob;public uint Persist;public uint AttributeCount;public IntPtr Attributes;public string TargetAlias;public string UserName;}[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool CredRead(string target,uint type,uint flags,out IntPtr credential);[DllImport("advapi32.dll")]public static extern void CredFree(IntPtr buffer);}\'',
  "$p=[IntPtr]::Zero",
  "if(-not [OctantCred]::CredRead($env:OCTANT_CRED_TARGET,1,0,[ref]$p)){exit 3}",
  "$c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][OctantCred+CRED])",
  "$b=New-Object byte[] $c.CredentialBlobSize",
  "[Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$b,0,$c.CredentialBlobSize)",
  "[OctantCred]::CredFree($p)",
  "[Console]::Out.Write([Text.Encoding]::Unicode.GetString($b))",
].join("; ");

export interface WindowsCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
}

export interface WindowsCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WindowsCommandLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export type WindowsCommandExecutor = (
  spec: WindowsCommandSpec,
  limits: WindowsCommandLimits,
) => Promise<WindowsCommandResult>;

export interface MakeWindowsCredentialStoreOptions {
  readonly execute?: WindowsCommandExecutor;
  readonly timeoutMs?: number;
}

export function makeWindowsCredentialStore(
  options: MakeWindowsCredentialStoreOptions = {},
): CredentialStore {
  const execute = options.execute ?? executeWindowsCommand;
  const limits = {
    maxBytes: MAX_OUTPUT_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  if (limits.timeoutMs <= 0) throw new CredentialStoreFailure("invalid");

  const targetFor = (providerInstanceId: string): string => {
    if (!UUID_PATTERN.test(providerInstanceId)) throw new CredentialStoreFailure("invalid");
    return `${TARGET_PREFIX}${providerInstanceId}`;
  };

  const run = async (spec: WindowsCommandSpec): Promise<WindowsCommandResult> => {
    try {
      return await execute(spec, limits);
    } catch {
      throw new CredentialStoreFailure("unavailable");
    }
  };

  return {
    set: async (providerInstanceId, credential) => {
      if (credential.length === 0) throw new CredentialStoreFailure("invalid");
      const target = targetFor(providerInstanceId);
      // cmdkey takes the secret as an argument; it has no stdin form. The
      // process is short-lived, owned by this host, and never logged.
      const result = await run({
        command: CMDKEY_PATH,
        args: [`/generic:${target}`, "/user:octant", `/pass:${credential}`],
      });
      if (result.exitCode !== 0) throw new CredentialStoreFailure("failed");
    },
    has: async (providerInstanceId) => {
      const target = targetFor(providerInstanceId);
      const result = await run({ command: CMDKEY_PATH, args: [`/list:${target}`] });
      if (result.exitCode !== 0) return false;
      return result.stdout.includes(target);
    },
    resolve: async (providerInstanceId) => {
      const target = targetFor(providerInstanceId);
      const result = await run({
        command: POWERSHELL_PATH,
        args: ["-NoProfile", "-NonInteractive", "-Command", READ_CREDENTIAL_SCRIPT],
        // The target travels in the environment rather than the command line
        // so a credential id never appears in a process listing.
        environment: { ...process.env, OCTANT_CRED_TARGET: target },
      });
      if (result.exitCode === 3) throw new CredentialStoreFailure("missing");
      if (result.exitCode !== 0) throw new CredentialStoreFailure("failed");
      const credential = result.stdout;
      if (credential.length === 0) throw new CredentialStoreFailure("missing");
      return credential;
    },
    delete: async (providerInstanceId) => {
      const target = targetFor(providerInstanceId);
      const result = await run({ command: CMDKEY_PATH, args: [`/delete:${target}`] });
      if (result.exitCode !== 0) throw new CredentialStoreFailure("failed");
    },
  };
}

async function executeWindowsCommand(
  spec: WindowsCommandSpec,
  limits: WindowsCommandLimits,
): Promise<WindowsCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      ...(spec.environment === undefined ? {} : { env: spec.environment }),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows credential command timed out"));
    }, limits.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout, "utf8") <= limits.maxBytes) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") <= limits.maxBytes) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}
