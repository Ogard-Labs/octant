import { describe, expect, it } from "vitest";
import { buildLinuxProcessDenySeccompFilter } from "./linuxProcessDenySeccomp";

const BPF_JMP_JEQ_K = 0x15;
const SYS_X64 = {
  clone: 56,
  fork: 57,
  vfork: 58,
  execveat: 322,
  clone3: 435,
} as const;
const SYS_ARM64 = {
  clone: 220,
  execveat: 281,
  clone3: 435,
} as const;

describe("Linux process-deny seccomp filter", () => {
  it("encodes an x64 Plan filter that denies fork, clone3, and execveat", () => {
    const bytes = buildLinuxProcessDenySeccompFilter({
      arch: "x64",
      denyFork: true,
      denyExec: true,
    });
    expect(bytes.byteLength % 8).toBe(0);
    const kValues = immediateValues(bytes);
    expect(kValues).toEqual(expect.arrayContaining([SYS_X64.fork, SYS_X64.vfork, SYS_X64.clone]));
    expect(kValues).toContain(SYS_X64.clone3);
    expect(kValues).toContain(SYS_X64.execveat);
    expect(jumpImmediates(bytes)).toEqual(
      expect.arrayContaining([SYS_X64.fork, SYS_X64.clone3, SYS_X64.execveat]),
    );
  });

  it("encodes an arm64 Plan filter without the x64-only fork syscalls", () => {
    const bytes = buildLinuxProcessDenySeccompFilter({
      arch: "arm64",
      denyFork: true,
      denyExec: true,
    });
    const jumps = jumpImmediates(bytes);
    expect(jumps).toEqual(
      expect.arrayContaining([SYS_ARM64.clone, SYS_ARM64.clone3, SYS_ARM64.execveat]),
    );
    expect(jumps).not.toContain(SYS_X64.fork);
    expect(jumps).not.toContain(SYS_X64.vfork);
  });

  it("omits execveat when only process-fork is denied", () => {
    const bytes = buildLinuxProcessDenySeccompFilter({
      arch: "x64",
      denyFork: true,
      denyExec: false,
    });
    expect(jumpImmediates(bytes)).toContain(SYS_X64.clone);
    expect(jumpImmediates(bytes)).not.toContain(SYS_X64.execveat);
  });

  it("omits fork and clone when only process-exec is denied", () => {
    const bytes = buildLinuxProcessDenySeccompFilter({
      arch: "x64",
      denyFork: false,
      denyExec: true,
    });
    const jumps = jumpImmediates(bytes);
    expect(jumps).toContain(SYS_X64.execveat);
    expect(jumps).not.toContain(SYS_X64.fork);
    expect(jumps).not.toContain(SYS_X64.clone);
    expect(jumps).not.toContain(SYS_X64.clone3);
  });
});

function immediateValues(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    values.push(view.getUint32(offset + 4, true));
  }
  return values;
}

function jumpImmediates(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    if (view.getUint16(offset, true) !== BPF_JMP_JEQ_K) continue;
    values.push(view.getUint32(offset + 4, true));
  }
  return values;
}
