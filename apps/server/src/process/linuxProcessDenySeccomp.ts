/**
 * Classic BPF seccomp program for Linux Plan/Chat process denial.
 *
 * Bubblewrap applies the filter before it execve's the command, so this
 * program never denies execve. It denies process creation (fork/vfork and
 * non-thread clone, with clone3 returning ENOSYS so libc falls back) and
 * execveat (memfd and *at exec). See docs/decisions/0068.
 */

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_ALU_AND_K = 0x54;
const BPF_RET_K = 0x06;

const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;
const ENOSYS = 38;
const CLONE_THREAD = 0x00010000;

const SECCOMP_DATA_NR = 0;
const SECCOMP_DATA_ARCH = 4;
const SECCOMP_DATA_ARGS0 = 16;

const AUDIT_ARCH = {
  x64: 0xc000003e,
  arm64: 0xc00000b7,
} as const;

const SYSCALLS = {
  x64: { clone: 56, fork: 57, vfork: 58, execveat: 322, clone3: 435 },
  arm64: { clone: 220, execveat: 281, clone3: 435 },
} as const;

export interface LinuxProcessDenySeccompInput {
  readonly arch: "x64" | "arm64";
  readonly denyFork: boolean;
  readonly denyExec: boolean;
}

type FilterOp =
  | { readonly op: "ld"; readonly offset: number }
  | { readonly op: "and"; readonly k: number }
  | { readonly op: "jeq"; readonly k: number; readonly match: string; readonly miss: string }
  | { readonly op: "ret"; readonly k: number }
  | { readonly op: "label"; readonly name: string };

export function buildLinuxProcessDenySeccompFilter(
  input: LinuxProcessDenySeccompInput,
): Uint8Array {
  if (!input.denyFork && !input.denyExec) {
    throw new Error("Linux process-deny filter requires denyFork or denyExec.");
  }

  const ops: FilterOp[] = [
    { op: "ld", offset: SECCOMP_DATA_ARCH },
    { op: "jeq", k: AUDIT_ARCH[input.arch], match: "nr", miss: "kill" },
    { op: "label", name: "nr" },
    { op: "ld", offset: SECCOMP_DATA_NR },
  ];

  if (input.denyFork) {
    ops.push(
      { op: "jeq", k: SYSCALLS[input.arch].clone3, match: "enosys", miss: "after_clone3" },
      { op: "label", name: "after_clone3" },
    );
    if (input.arch === "x64") {
      ops.push(
        { op: "jeq", k: SYSCALLS.x64.fork, match: "eperm", miss: "after_fork" },
        { op: "label", name: "after_fork" },
        { op: "jeq", k: SYSCALLS.x64.vfork, match: "eperm", miss: "after_vfork" },
        { op: "label", name: "after_vfork" },
      );
    }
    ops.push(
      { op: "jeq", k: SYSCALLS[input.arch].clone, match: "check_clone", miss: "after_clone" },
      { op: "label", name: "after_clone" },
    );
  }

  if (input.denyExec) {
    ops.push({ op: "jeq", k: SYSCALLS[input.arch].execveat, match: "eperm", miss: "allow" });
  } else {
    ops.push({ op: "ret", k: SECCOMP_RET_ALLOW });
  }

  if (input.denyFork) {
    ops.push(
      { op: "label", name: "check_clone" },
      { op: "ld", offset: SECCOMP_DATA_ARGS0 },
      { op: "and", k: CLONE_THREAD },
      { op: "jeq", k: CLONE_THREAD, match: "allow", miss: "eperm" },
      { op: "label", name: "enosys" },
      { op: "ret", k: SECCOMP_RET_ERRNO | ENOSYS },
    );
  }

  ops.push(
    { op: "label", name: "kill" },
    { op: "ret", k: SECCOMP_RET_KILL_PROCESS },
    { op: "label", name: "eperm" },
    { op: "ret", k: SECCOMP_RET_ERRNO | EPERM },
    { op: "label", name: "allow" },
    { op: "ret", k: SECCOMP_RET_ALLOW },
  );

  return assemble(ops);
}

function assemble(ops: ReadonlyArray<FilterOp>): Uint8Array {
  const insns: Array<Exclude<FilterOp, { readonly op: "label" }>> = [];
  const labels = new Map<string, number>();
  for (const op of ops) {
    if (op.op === "label") {
      labels.set(op.name, insns.length);
      continue;
    }
    insns.push(op);
  }

  const encoded = new Uint8Array(insns.length * 8);
  const view = new DataView(encoded.buffer);
  for (const [index, insn] of insns.entries()) {
    const offset = index * 8;
    switch (insn.op) {
      case "ld":
        view.setUint16(offset, BPF_LD_W_ABS, true);
        view.setUint32(offset + 4, insn.offset, true);
        break;
      case "and":
        view.setUint16(offset, BPF_ALU_AND_K, true);
        view.setUint32(offset + 4, insn.k, true);
        break;
      case "ret":
        view.setUint16(offset, BPF_RET_K, true);
        view.setUint32(offset + 4, insn.k, true);
        break;
      case "jeq": {
        const matchIdx = labels.get(insn.match);
        const missIdx = labels.get(insn.miss);
        if (matchIdx === undefined || missIdx === undefined) {
          throw new Error(`Linux seccomp assembler missing label ${insn.match} or ${insn.miss}.`);
        }
        const jt = matchIdx - index - 1;
        const jf = missIdx - index - 1;
        if (jt < 0 || jf < 0 || jt > 255 || jf > 255) {
          throw new Error("Linux seccomp assembler jump is out of range.");
        }
        view.setUint16(offset, BPF_JMP_JEQ_K, true);
        view.setUint8(offset + 2, jt);
        view.setUint8(offset + 3, jf);
        view.setUint32(offset + 4, insn.k, true);
        break;
      }
    }
  }
  return encoded;
}
