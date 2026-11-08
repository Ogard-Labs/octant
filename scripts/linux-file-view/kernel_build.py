"""Build only an owned networkless CI guest; never installs a host component."""

import hashlib
import io
import json
import os
import re
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import sys
import tarfile
import urllib.request
from kernel_patch import install_epochs

KERNEL = "6.18"
DIGEST = "9106a4605da9e31ff17659d958782b815f9591ab308d03b0ee21aad6c7dced4b"


def run(*arguments, cwd=None, timeout=900, output=None):
    bounded = ("timeout", "--kill-after=3s", f"{timeout}s", *arguments)
    process = subprocess.Popen(bounded, cwd=cwd, stdout=output,
                               stderr=subprocess.STDOUT if output else None, start_new_session=True)
    print(f"OCTANT_KERNEL_COMMAND pid={process.pid} group={process.pid} command={arguments[0]} maximum={timeout}s", flush=True)
    try:
        result = process.wait(timeout=timeout + 5)
    except BaseException:
        # This process group was created here; never stop a shared host tool.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=3)
        raise
    if result:
        raise subprocess.CalledProcessError(result, arguments)


def controller_image(path: Path, module_id=None) -> None:
    # Attest the actual compiled executable used below, not just a matching
    # release version. No symbol file or diagnostic payload leaves this runner.
    identifiers, loads = [], []
    executable_bytes = 0
    with path.open("rb") as source:
        length = path.stat().st_size
        header = source.read(64)
        if (length > 512 * 1024 * 1024 or header[:6] != b"\x7fELF\x02\x01" or len(header) != 64 or
                struct.unpack_from("<H", header, 18)[0] != 62):
            raise SystemExit("Controller image is not the expected bounded ELF64 file.")
        offset = struct.unpack_from("<Q", header, 32)[0]
        entry_size, count = struct.unpack_from("<HH", header, 54)
        if entry_size != 56 or count > 64 or offset + count * entry_size > length:
            raise SystemExit("Controller program-header layout is unavailable.")
        for index in range(count):
            source.seek(offset + index * entry_size)
            kind, flags, start, address, _, size, memory, _ = struct.unpack("<IIQQQQQQ", source.read(56))
            if start > length or size > length - start:
                raise SystemExit("Controller program segment exceeds its actual file.")
            if kind == 1 and flags & 1:
                executable_bytes += size
                if executable_bytes > 256 * 1024 * 1024:
                    raise SystemExit("Controller executable segment exceeds its diagnostic bound.")
                source.seek(start)
                digest = hashlib.sha256()
                remaining = size
                while remaining:
                    block = source.read(min(remaining, 1024 * 1024))
                    if not block:
                        raise SystemExit("Controller executable segment is truncated.")
                    digest.update(block)
                    remaining -= len(block)
                loads.append({"address": hex(address), "fileOffset": start, "fileBytes": size,
                              "memoryBytes": memory, "sha256": digest.hexdigest()})
            elif kind == 4:
                if size > 65536:
                    raise SystemExit("Controller note segment exceeds its diagnostic bound.")
                source.seek(start)
                notes, position = source.read(size), 0
                while position + 12 <= len(notes):
                    name_size, value_size, note_type = struct.unpack_from("<III", notes, position)
                    position += 12
                    name_end = position + name_size
                    value_start = position + ((name_size + 3) & ~3)
                    value_end = value_start + value_size
                    if name_end > len(notes) or value_end > len(notes):
                        raise SystemExit("Controller ELF note is truncated.")
                    if notes[position:name_end].rstrip(b"\0") == b"GNU" and note_type == 3:
                        identifiers.append(notes[value_start:value_end].hex())
                    position = value_start + ((value_size + 3) & ~3)
    if not identifiers or not loads:
        raise SystemExit("Controller build identity or executable loads are unavailable.")
    receipt = {"buildIds": identifiers, "executableLoads": loads, "diagnostic": True}
    if module_id is not None:
        receipt["moduleId"] = module_id
    print(("OCTANT_MODULE_IMAGE " if module_id is not None else "OCTANT_CONTROLLER_IMAGE ") +
          json.dumps(receipt), flush=True)


def main():
    if sys.platform != "linux" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("The kernel build is restricted to the owned ephemeral Linux CI job.")
    repository = Path(__file__).resolve().parents[2]
    root = Path(os.environ["RUNNER_TEMP"]) / "octant-kernel-guest"
    root.mkdir(mode=0o700)
    with urllib.request.urlopen(f"https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-{KERNEL}.tar.xz", timeout=60) as response:
        archive = response.read(160 * 1024 * 1024 + 1)
    if len(archive) > 160 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != DIGEST:
        raise SystemExit("Pinned upstream kernel archive size or digest differs.")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:xz") as source:
        source.extractall(root, filter="data")
    kernel = root / f"linux-{KERNEL}"
    native = repository / "apps/server/native/linux-mediation"
    destination = kernel / "security/octant_mediation"
    destination.mkdir()
    for name in ("mediation.c", "octant_mediation.h", "bridge.h"):
        shutil.copyfile(native / name, destination / name)
    install_epochs(kernel, native)
    (destination / "Makefile").write_text("obj-y += mediation.o\n")
    with (kernel / "security/Makefile").open("a") as output:
        output.write("\nobj-$(CONFIG_SECURITY_OCTANT_MEDIATION) += octant_mediation/\n")
    with (kernel / "security/Kconfig").open("a") as output:
        output.write('\nconfig SECURITY_OCTANT_MEDIATION\n\tbool "Octant disposable admission bridge"\n\tdepends on SECURITY\n\tselect SECURITY_PATH\n\tdefault n\n')
    run("make", "tinyconfig", cwd=kernel)
    for symbol in ("64BIT", "SMP", "MULTIUSER", "PRINTK", "TTY", "SERIAL_8250", "SERIAL_8250_CONSOLE",
                   "BLK_DEV_INITRD", "BINFMT_ELF", "PROC_FS", "SYSFS", "TMPFS", "SHMEM",
                   "DEVTMPFS", "TMPFS_XATTR", "TMPFS_POSIX_ACL", "EXT4_FS_POSIX_ACL",
                   "SECURITY", "SECURITY_PATH", "SECURITY_OCTANT_MEDIATION", "IO_URING", "AIO",
                   "FUTEX", "PCI", "BLOCK", "ACPI", "EPOLL", "EVENTFD", "TIMERFD",
                   "SIGNALFD", "INOTIFY_USER", "ADVISE_SYSCALLS", "MEMFD_CREATE", "POSIX_TIMERS",
                   "FILE_LOCKING", "NET", "UNIX", "NAMESPACES", "USER_NS", "PID_NS", "UTS_NS",
                   "IPC_NS", "NET_NS", "SECCOMP", "SECCOMP_FILTER", "INET", "SYSVIPC",
                   "UNIX98_PTYS", "DEVPTS_FS", "BLK_DEV", "EXT4_FS", "VIRTIO",
                   "VIRTIO_MENU", "VIRTIO_PCI", "VIRTIO_BLK", "DEVTMPFS_MOUNT",
                   "COREDUMP", "ELF_CORE", "PROC_SYSCTL"):
        run("scripts/config", "--enable", symbol, cwd=kernel, timeout=10)
    run("scripts/config", "--set-val", "NR_CPUS", "2", cwd=kernel, timeout=10)
    run("scripts/config", "--set-str", "LSM", "octant_mediation", cwd=kernel, timeout=10)
    run("make", "olddefconfig", cwd=kernel)
    configured = set((kernel / ".config").read_text().splitlines())
    for symbol in ("SMP", "BLOCK", "BLK_DEV", "PCI", "VIRTIO_MENU", "VIRTIO_PCI", "VIRTIO_BLK",
                   "EXT4_FS", "DEVTMPFS", "DEVTMPFS_MOUNT", "USER_NS", "PID_NS", "NET_NS",
                   "SECURITY", "SECURITY_PATH", "SECURITY_OCTANT_MEDIATION",
                   "TMPFS_XATTR", "TMPFS_POSIX_ACL", "EXT4_FS_POSIX_ACL",
                   "COREDUMP", "ELF_CORE", "PROC_SYSCTL", "SYSCTL"):
        if f"CONFIG_{symbol}=y" not in configured:
            raise SystemExit(f"Required built-in guest prerequisite is unavailable: {symbol}")
    if "CONFIG_NR_CPUS=2" not in configured:
        raise SystemExit("The guest requires exactly two configured CPUs for parallel native proof.")
    if "CONFIG_STATIC_USERMODEHELPER=y" in configured:
        raise SystemExit("The owned core collector requires its actual helper executable.")
    run("make", "-j2", "bzImage", cwd=kernel)
    init_binary = root / "init"
    run("gcc", "-static", "-pthread", "-std=c11", "-Wall", "-Wextra", "-Werror",
        str(repository / "scripts/linux-file-view/kernel_guest.c"), "-o", str(init_binary), timeout=30)
    relay = root / "octant-mediation"
    workload = root / "policy-workload"
    policy = root / "policy-broker"
    session_cases = root / "session-cases"
    core_notes_binary = root / "core-notes"
    core_probe = root / "core-probe"
    fileattr_workload = root / "fileattr-workload"
    for source, target in ((native / "broker.c", relay),
                           (repository / "scripts/linux-file-view/kernel_policy_workload.c", workload),
                           (repository / "scripts/linux-file-view/kernel_core_probe.c", core_probe),
                           (repository / "scripts/linux-file-view/kernel_fileattr_workload.c", fileattr_workload)):
        run("gcc", "-static", "-std=c11", "-Wall", "-Wextra", "-Werror", str(source), "-o", str(target), timeout=30)
    core_check = root / "core-notes-check"
    run("gcc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-DOCTANT_CORE_NOTES_TEST=1",
        str(repository / "scripts/linux-file-view/kernel_core_notes.c"), "-o", str(core_check), timeout=30)
    run(str(core_check), timeout=5, cwd=root)
    run("bun", "build", "--compile", str(repository / "scripts/linux-file-view/kernel_policy.ts"),
        "--outfile", str(policy), timeout=120, cwd=repository)
    run("bun", "build", "--compile", str(repository / "scripts/linux-file-view/kernel_session.ts"),
        "--outfile", str(session_cases), timeout=120, cwd=repository)
    controller_image(policy)
    # Same compiled classifier, default JIT, no device/enrollment on the stock
    # runner. Keep this independent control before any guest mitigation.
    run(str(policy), "--metadata-control", timeout=15, cwd=root)
    # Copy only this task-owned public executable's dynamic loader/libraries
    # into the disposable initramfs. Nothing is mounted from the runner home.
    runtime_files = {}
    for name in ("bun", "node"):
        runtime_path = shutil.which(name)
        if not runtime_path:
            raise SystemExit(f"The owned runtime proof requires {name}.")
        runtime_files[f"usr/bin/{name}"] = Path(runtime_path).resolve(strict=True)
    library_log = root / "policy-libraries.log"
    with library_log.open("wb") as output:
        run("ldd", str(policy), timeout=10, output=output)
        run("ldd", "/usr/bin/bwrap", timeout=10, output=output)
        run("ldd", str(session_cases), timeout=10, output=output)
        for runtime_path in runtime_files.values():
            run("ldd", str(runtime_path), timeout=10, output=output)
    guest_files = {"octant-mediation": relay, "policy-workload": workload,
                   "fileattr-workload": fileattr_workload,
                   "core-probe": core_probe,
                   "policy-broker": policy, "session-cases": session_cases, "usr/bin/bwrap": Path("/usr/bin/bwrap"),
                   "kernel-runtime.mjs": repository / "scripts/linux-file-view/kernel_runtime.mjs",
                   **runtime_files}
    module_names = {"policy-broker", "core-probe"}
    for path in re.findall(r"(?:=>\s+)?(/[^\s]+)", library_log.read_text()):
        library = Path(path)
        if not library.is_file():
            raise SystemExit("The owned policy binary has an unavailable dynamic dependency.")
        guest_files[path.removeprefix("/")] = library
        module_names.add(path.removeprefix("/"))
    # pivot_root cannot replace the kernel's initial rootfs. Give Bubblewrap
    # a real disposable root mount, without mounting or installing on the host.
    tree = root / "root-tree"
    tree.mkdir(mode=0o755)
    for directory in ("dev", "proc", "sys", "tmp"):
        (tree / directory).mkdir(mode=0o755)
    guest_files["init"] = init_binary
    for name, source in guest_files.items():
        destination = tree / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        destination.chmod(0o755)
    # Only the existing copied ELF inventory becomes fixed identity candidates.
    # No names from the crashing process or arbitrary runtime files are opened.
    if len(module_names) > 64:
        raise SystemExit("The copied diagnostic module inventory exceeds its bound.")
    entries = []
    module_ids = {}
    for module_id, name in enumerate(sorted(module_names), 1):
        if not re.fullmatch(r"[A-Za-z0-9_./+:-]+", name) or ".." in Path(name).parts:
            raise SystemExit("A copied diagnostic module path is not a fixed guest path.")
        module_ids[name] = module_id
        controller_image(tree / name, module_id)
        entries.append(f"  {{{module_id}, {json.dumps('/' + name)}}},")
    (root / "octant_core_modules.h").write_text(
        "static const struct module modules[] = {\n" + "\n".join(entries) + "\n};\n")
    run("gcc", "-static", "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", str(root),
        str(repository / "scripts/linux-file-view/kernel_core_notes.c"), "-o", str(core_notes_binary), timeout=30)
    shutil.copyfile(core_notes_binary, tree / "core-notes")
    (tree / "core-notes").chmod(0o755)
    image = root / "root.ext4"
    with image.open("wb") as output:
        output.truncate(512 * 1024 * 1024)
    # SETVERSION is natively unsupported with metadata checksums. Reuse this
    # same owned image without that optional feature to prove real mutations.
    run("mke2fs", "-q", "-F", "-t", "ext4", "-O", "^metadata_csum", "-d", str(tree), str(image), timeout=30)
    with (root / "guest.log").open("wb") as output:
        run("timeout", "--kill-after=3s", "150s", "qemu-system-x86_64", "-machine", "accel=tcg",
            "-cpu", "max", "-m", "512M", "-smp", "2", "-nic", "none", "-nographic",
            "-no-reboot", "-kernel", str(kernel / "arch/x86/boot/bzImage"),
            "-drive", f"file={image},format=raw,if=virtio",
            "-append", "console=ttyS0 root=/dev/vda rootfstype=ext4 rw init=/init panic=-1",
            timeout=155, cwd=root, output=output)
    log = (root / "guest.log").read_text(errors="replace")
    print(log[-20000:])
    cases = []
    ordered = []
    runtime_receipts = []
    runtime_joins = []
    outside = []
    fileattr_cases, fileattr_owners, fileattr_filesystems, fileattr_brokers = [], [], [], []
    probe_addresses, probe_exits, core_notes, core_targets, core_retirements, processes = [], [], [], [], [], []
    for line in log.splitlines():
        if line.startswith("{"):
            value = json.loads(line)
            if value.get("status") == "measured-original-policy-broker":
                cases.append(value)
            elif value.get("status") == "measured-kernel-runtime":
                runtime_receipts.append(value)
            elif value.get("status") in ("measured-fileattr-broker", "failed-fileattr-broker"):
                fileattr_brokers.append(value)
        elif line.startswith("OCTANT_FILEATTR_CASE "):
            fileattr_cases.append(json.loads(line.split(" ", 1)[1]))
        elif line.startswith("OCTANT_FILEATTR_OWNER "):
            fileattr_owners.append(json.loads(line.split(" ", 1)[1]))
        elif line.startswith("OCTANT_FILEATTR_FILESYSTEM "):
            fileattr_filesystems.append(json.loads(line.split(" ", 1)[1]))
        elif line.startswith("OCTANT_ORDERED_ADMISSIONS "):
            ordered.append(json.loads(line.split(" ", 1)[1]))
        elif line.startswith("OCTANT_OUTSIDE_EPOCH "):
            outside.append(json.loads(line.split(" ", 1)[1]))
        elif line.startswith("OCTANT_CORE_PROBE_ADDRESS "):
            probe_addresses.append(json.loads(line.split(" ", 1)[1]))
        elif line.startswith("OCTANT_CORE_PROBE "):
            probe_exits.append(json.loads(line.split(" ", 1)[1]))
        elif line.startswith("OCTANT_CORE_NOTES "):
            core_notes.append(json.loads(line.split(" ", 1)[1]))
        elif line.startswith("OCTANT_CORE_TARGET "):
            core_targets.append(json.loads(line.split(" ", 1)[1]))
        elif line.startswith("OCTANT_CORE_RETIRE "):
            core_retirements.append(json.loads(line.split(" ", 1)[1]))
        elif line.startswith("OCTANT_POLICY_PROCESS "):
            processes.append(json.loads(line.split(" ", 1)[1]))
        elif line.startswith("OCTANT_RUNTIME_JOIN "):
            runtime_joins.append(json.loads(line.split(" ", 1)[1]))
    probe_notes = [note for note in core_notes if note.get("role") == 2]
    probe_targets = [target for target in core_targets if target.get("role") == 2]
    if any(len(items) != 1 for items in (probe_addresses, probe_exits, probe_notes, probe_targets)):
        raise SystemExit("The genuine owned core probe lacks a single correlated kernel collector receipt.")
    address, ended, note, target = probe_addresses[0], probe_exits[0], probe_notes[0], probe_targets[0]
    pid = address.get("pid")
    retired = [entry for entry in core_retirements if entry.get("pid") == pid]
    if (address.get("coreSoft") != 0 or ended.get("pid") != pid or target.get("pid") != pid or
            note.get("pid") != pid or note.get("tid") != pid or note.get("address") != address.get("address") or
            note.get("device") != target.get("device") or note.get("inode") != target.get("inode") or
            ended.get("joined") is not True or ended.get("signalExpected") is not True or ended.get("signal") != 11 or
            note.get("signal") != 11 or note.get("siCode") != 2 or target.get("bound") is not True or
            note.get("fileMapping") is not True or note.get("moduleId") != module_ids["core-probe"] or
            note.get("mappingDevice") != target.get("device") or note.get("mappingInode") != target.get("inode") or
            not isinstance(note.get("helperPid"), int) or note["helperPid"] <= 0 or note["helperPid"] == pid or
            any(note.get(field) is not True for field in ("confirmed", "owned", "pidfdValidated", "hardwareFault", "terminationContext", "beforeMemory")) or
            not isinstance(note.get("bytes"), int) or not 0 < note["bytes"] <= 128 * 1024 or
            not isinstance(note.get("firstLoad"), int) or note["bytes"] > note["firstLoad"] or
            len(retired) != 1 or retired[0].get("held") is not True or retired[0].get("retired") is not True):
        raise SystemExit("The actual CORE0/PROT_NONE probe, kernel pidfd, executable and prefix notes did not agree.")
    sessions = [json.loads(line) for line in log.splitlines() if line.startswith('{"status":"measured-owned-mediation-session"')]
    session_joins = [json.loads(line.split(" ", 1)[1]) for line in log.splitlines() if line.startswith("OCTANT_SESSION_JOIN ")]
    expected_sessions = {"invalid-deadline-refuses-before-spawn", "close-before-launch-no-command", "early-exit-real-code",
                         "caller-cancellation-joins", "deadline-joins", "bounded-duplex-pressure-and-private-receipt-mask",
                         "owner-loss-EOF-admission-and-command-stop"}
    if (len(sessions) != 1 or set(sessions[0].get("outcomes", [])) != expected_sessions or
            sessions[0].get("actualBubblewrapBuilder") is not True or sessions[0].get("productionReady") is not False or
            len(session_joins) != 1 or any(session_joins[0].get(key) != value for key, value in {"controllerJoined": True, "controllerCode": 0, "orphansJoined": 1, "remaining": False}.items())):
        raise SystemExit("The actual owned session needs all lifecycle/stdio/private-root controls and exact orphan joins.")
    expected_modes = ["--metadata-control", "direct", "--bubblewrap", "--bubblewrap", "--bubblewrap",
                      "--runtime-bun", "--runtime-node", "--fileattr"]
    if (len(processes) != 8 or sorted(entry.get("mode", "") for entry in processes) != sorted(expected_modes) or
            len(core_targets) != 9 or len(core_retirements) != 10 or
            {entry.get("pid") for entry in core_retirements} != {pid, *(entry.get("pid") for entry in processes), session_joins[0].get("controllerPid")} or
            any(entry.get("held") is not True or entry.get("retired") is not True for entry in core_retirements) or
            any(entry.get("diagnosticObserver") is not False or entry.get("joined") is not True
                for entry in processes)):
        raise SystemExit("Every captured PID must stay held until inactive-pipe retirement, with no tracer.")
    if (len(fileattr_cases) != 1 or len(fileattr_owners) != 1 or len(fileattr_filesystems) != 1 or
            len(fileattr_brokers) != 1 or fileattr_filesystems[0] != {"ext4": True, "baselineRead": True} or
            any(fileattr_cases[0].get(field) is not True for field in
                ("privateReadRefused", "privateReadOutputUnchanged", "privateRefused", "publicChanged", "publicRestored", "permittedWrite")) or
            fileattr_cases[0].get("privateReadResult") != -1 or fileattr_cases[0].get("privateReadErrno") != 13 or
            fileattr_cases[0].get("privateErrno") != 13 or fileattr_cases[0].get("privateResult") != -1 or
            any(fileattr_owners[0].get(field) is not True for field in
                ("measured", "flagsUnchanged", "statUnchanged", "unchanged")) or
            fileattr_brokers[0].get("status") != "measured-fileattr-broker" or
            fileattr_brokers[0].get("actualBubblewrapBuilder") is not True or
            fileattr_brokers[0].get("ownedCommandJoined") is not True or
            fileattr_brokers[0].get("cleaned") is not True):
        raise SystemExit("The ext4 attributes need private read/mutation refusals, unchanged output/owner state and public positive controls.")
    if any(entry.get("code") != 0 or entry.get("signal") != 0 for entry in processes):
        raise SystemExit("Every untraced policy process must also exit normally with code zero.")
    expected_outside = {"pivot-root", "remount", "mount-setattr", "propagation", "open-create",
                        "tmpfile", "empty-link", "rename", "bind-mount", "bind-remount"}
    if ("OCTANT_KERNEL_CPUS 2" not in log or len(outside) != len(expected_outside) or
            {case.get("case") for case in outside} != expected_outside or any(
                any(case.get(field) is not True for field in
                    ("mutationSucceeded", "epochAdvanced", "staleRefused", "freshAllowed",
                     "childrenJoined", "cleaned", "passed")) for case in outside)):
        raise SystemExit("Every outside-mutation epoch case requires actual stale/fresh/cleanup proof on two CPUs.")
    if '"status":"measured-unconfined-classifier","snapshots":256,"jitDefaults":true,"enrolled":false,"cleaned":true' not in log:
        raise SystemExit("The guest default-JIT classifier control requires an actual cleanup receipt.")
    capsules = [case for case in cases if case.get("actualBubblewrapBuilder") is True and
                case.get("runtime") == "native"]
    direct = [case for case in cases if case.get("actualBubblewrapBuilder") is False]
    runtime_cases = [case for case in cases if case.get("runtime") in ("bun", "node")]
    if len(capsules) != 3 or len(direct) != 1 or len(runtime_cases) != 2 or any(
            case.get("ended") != {"status": "exited", "code": 0} or
            case.get("ownedCommandJoined") is not True or case.get("cleaned") is not True or
            case.get("lateCompanion") is not True for case in cases):
        raise SystemExit("Every original-policy case needs an actual exit/join/cleanup receipt.")
    if any(case.get("metadataUnchanged") is not True for case in [*capsules, *direct]):
        raise SystemExit("The independent owner must verify private xattrs and mode unchanged.")
    expected = {"bun", "node"}
    if {case.get("runtime") for case in runtime_receipts} != expected or len(runtime_receipts) != 2 or any(
            case.get("jitDefaults") is not True for case in runtime_receipts) or any(
            case.get("actualBubblewrapBuilder") is not True for case in runtime_cases):
        raise SystemExit("Both real runtime workloads need their actual capsule receipt.")
    if len(ordered) != 1 or ordered[0].get("status") != "measured-ordered-admissions" or \
            ordered[0].get("ownedChildJoined") is not True or ordered[0].get("cleaned") is not True:
        raise SystemExit("The controlled queued-read ordering proof did not pass.")
    for attempt in range(1, 4):
        if f"OCTANT_BUBBLEWRAP_ATTEMPT {attempt} result=0" not in log:
            raise SystemExit("An uninstrumented ordinary capsule repetition did not complete.")
    if len(runtime_joins) != 1 or runtime_joins[0] != {"orphansJoined": 0, "remaining": False}:
        raise SystemExit("Both runtime controllers require a final zero-leftover ECHILD cleanup receipt.")
    if ("OCTANT_KERNEL_EXIT 0" not in log or '"status":"measured-admission-core"' not in log or
            '"status":"measured-namespace-token"' not in log or
            '"status":"measured-original-policy-broker"' not in log or
            '"actualBubblewrapBuilder":true' not in log):
        raise SystemExit("The guest admission core did not pass; no production proof is inferred.")


if __name__ == "__main__":
    def interrupted(number, frame):
        raise SystemExit(128 + number)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    main()
