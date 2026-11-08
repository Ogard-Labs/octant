"""Build only an owned networkless CI guest; never installs a host component."""

import hashlib
import io
import json
import os
import re
from pathlib import Path
import shutil
import signal
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
    for symbol in ("64BIT", "MULTIUSER", "PRINTK", "TTY", "SERIAL_8250", "SERIAL_8250_CONSOLE",
                   "BLK_DEV_INITRD", "BINFMT_ELF", "PROC_FS", "SYSFS", "TMPFS", "SHMEM",
                   "DEVTMPFS", "SECURITY", "SECURITY_PATH", "SECURITY_OCTANT_MEDIATION", "IO_URING", "AIO",
                   "FUTEX", "PCI", "BLOCK", "ACPI", "EPOLL", "EVENTFD", "TIMERFD",
                   "SIGNALFD", "INOTIFY_USER", "ADVISE_SYSCALLS", "MEMFD_CREATE", "POSIX_TIMERS",
                   "FILE_LOCKING", "NET", "UNIX", "NAMESPACES", "USER_NS", "PID_NS", "UTS_NS",
                   "IPC_NS", "NET_NS", "SECCOMP", "SECCOMP_FILTER", "INET", "SYSVIPC",
                   "UNIX98_PTYS", "DEVPTS_FS", "BLK_DEV", "EXT4_FS", "VIRTIO",
                   "VIRTIO_MENU", "VIRTIO_PCI", "VIRTIO_BLK", "DEVTMPFS_MOUNT"):
        run("scripts/config", "--enable", symbol, cwd=kernel, timeout=10)
    run("scripts/config", "--set-str", "LSM", "octant_mediation", cwd=kernel, timeout=10)
    run("make", "olddefconfig", cwd=kernel)
    configured = set((kernel / ".config").read_text().splitlines())
    for symbol in ("BLOCK", "BLK_DEV", "PCI", "VIRTIO_MENU", "VIRTIO_PCI", "VIRTIO_BLK",
                   "EXT4_FS", "DEVTMPFS", "DEVTMPFS_MOUNT", "USER_NS", "PID_NS", "NET_NS",
                   "SECURITY", "SECURITY_PATH", "SECURITY_OCTANT_MEDIATION"):
        if f"CONFIG_{symbol}=y" not in configured:
            raise SystemExit(f"Required built-in guest prerequisite is unavailable: {symbol}")
    run("make", "-j2", "bzImage", cwd=kernel)
    executable = root / "init"
    run("gcc", "-static", "-pthread", "-std=c11", "-Wall", "-Wextra", "-Werror",
        str(repository / "scripts/linux-file-view/kernel_guest.c"), "-o", str(executable), timeout=30)
    relay = root / "octant-mediation"
    workload = root / "policy-workload"
    policy = root / "policy-broker"
    for source, target in ((native / "broker.c", relay),
                           (repository / "scripts/linux-file-view/kernel_policy_workload.c", workload)):
        run("gcc", "-static", "-std=c11", "-Wall", "-Wextra", "-Werror", str(source), "-o", str(target), timeout=30)
    run("bun", "build", "--compile", str(repository / "scripts/linux-file-view/kernel_policy.ts"),
        "--outfile", str(policy), timeout=120, cwd=repository)
    # Copy only this task-owned public executable's dynamic loader/libraries
    # into the disposable initramfs. Nothing is mounted from the runner home.
    library_log = root / "policy-libraries.log"
    with library_log.open("wb") as output:
        run("ldd", str(policy), timeout=10, output=output)
        run("ldd", "/usr/bin/bwrap", timeout=10, output=output)
    guest_files = {"octant-mediation": relay, "policy-workload": workload,
                   "policy-broker": policy, "usr/bin/bwrap": Path("/usr/bin/bwrap")}
    for path in re.findall(r"(?:=>\s+)?(/[^\s]+)", library_log.read_text()):
        library = Path(path)
        if not library.is_file():
            raise SystemExit("The owned policy binary has an unavailable dynamic dependency.")
        guest_files[path.removeprefix("/")] = library
    # pivot_root cannot replace the kernel's initial rootfs. Give Bubblewrap
    # a real disposable root mount, without mounting or installing on the host.
    tree = root / "root-tree"
    tree.mkdir(mode=0o755)
    for directory in ("dev", "proc", "sys", "tmp"):
        (tree / directory).mkdir(mode=0o755)
    guest_files["init"] = executable
    for name, source in guest_files.items():
        destination = tree / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        destination.chmod(0o755)
    image = root / "root.ext4"
    with image.open("wb") as output:
        output.truncate(256 * 1024 * 1024)
    run("mke2fs", "-q", "-F", "-t", "ext4", "-d", str(tree), str(image), timeout=30)
    with (root / "guest.log").open("wb") as output:
        run("timeout", "--kill-after=3s", "90s", "qemu-system-x86_64", "-machine", "accel=tcg",
            "-cpu", "max", "-m", "512M", "-smp", "2", "-nic", "none", "-nographic",
            "-no-reboot", "-kernel", str(kernel / "arch/x86/boot/bzImage"),
            "-drive", f"file={image},format=raw,if=virtio",
            "-append", "console=ttyS0 root=/dev/vda rootfstype=ext4 rw init=/init panic=-1",
            timeout=95, cwd=root, output=output)
    log = (root / "guest.log").read_text(errors="replace")
    print(log[-20000:])
    cases = []
    ordered = []
    for line in log.splitlines():
        if line.startswith("{"):
            value = json.loads(line)
            if value.get("status") == "measured-original-policy-broker":
                cases.append(value)
        elif line.startswith("OCTANT_ORDERED_ADMISSIONS "):
            ordered.append(json.loads(line.split(" ", 1)[1]))
    capsules = [case for case in cases if case.get("actualBubblewrapBuilder") is True]
    direct = [case for case in cases if case.get("actualBubblewrapBuilder") is False]
    if len(capsules) != 3 or len(direct) != 1 or any(
            case.get("ended") != {"status": "exited", "code": 0} or
            case.get("ownedCommandJoined") is not True or case.get("cleaned") is not True or
            case.get("lateCompanion") is not True for case in cases):
        raise SystemExit("Every original-policy case needs an actual exit/join/cleanup receipt.")
    if len(ordered) != 1 or ordered[0].get("status") != "measured-ordered-admissions" or \
            ordered[0].get("ownedChildJoined") is not True or ordered[0].get("cleaned") is not True:
        raise SystemExit("The controlled queued-read ordering proof did not pass.")
    for attempt in range(1, 4):
        if f"OCTANT_BUBBLEWRAP_ATTEMPT {attempt} result=0" not in log:
            raise SystemExit("An uninstrumented ordinary capsule repetition did not complete.")
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
