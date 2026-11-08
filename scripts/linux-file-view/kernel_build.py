"""Build only an owned networkless CI guest; never installs a host component."""

import hashlib
import io
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


def archive_entry(output, name, data, mode, number, device=(0, 0)):
    encoded = name.encode() + b"\0"
    fields = [number, mode, 0, 0, 1, 0, len(data), 0, 0, device[0], device[1], len(encoded), 0]
    output.write(b"070701" + b"".join(f"{field:08x}".encode() for field in fields))
    output.write(encoded)
    output.write(b"\0" * (-(110 + len(encoded)) % 4))
    output.write(data)
    output.write(b"\0" * (-len(data) % 4))


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
                   "UNIX98_PTYS", "DEVPTS_FS"):
        run("scripts/config", "--enable", symbol, cwd=kernel, timeout=10)
    run("scripts/config", "--set-str", "LSM", "octant_mediation", cwd=kernel, timeout=10)
    run("make", "olddefconfig", cwd=kernel)
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
    run("bun", str(repository / "scripts/linux-file-view/kernel_bundle.ts"), str(policy),
        timeout=120, cwd=repository)
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
    with (root / "initramfs.cpio").open("wb") as output:
        archive_entry(output, "dev", b"", 0o040755, 1)
        archive_entry(output, "dev/console", b"", 0o020600, 2, device=(5, 1))
        archive_entry(output, "init", executable.read_bytes(), 0o100755, 3)
        number = 4
        directories = {"dev"}
        for name, path in guest_files.items():
            for parent in reversed(Path(name).parents):
                directory = str(parent)
                if directory == "." or directory in directories:
                    continue
                archive_entry(output, directory, b"", 0o040755, number)
                number += 1
                directories.add(directory)
            archive_entry(output, name, path.read_bytes(), 0o100755, number)
            number += 1
        archive_entry(output, "TRAILER!!!", b"", 0, number)
    with (root / "guest.log").open("wb") as output:
        run("timeout", "--kill-after=3s", "45s", "qemu-system-x86_64", "-machine", "accel=tcg",
            "-cpu", "max", "-m", "512M", "-smp", "2", "-nic", "none", "-nographic",
            "-no-reboot", "-kernel", str(kernel / "arch/x86/boot/bzImage"),
            "-initrd", str(root / "initramfs.cpio"), "-append", "console=ttyS0 panic=-1",
            timeout=50, cwd=root, output=output)
    log = (root / "guest.log").read_text(errors="replace")
    print(log[-20000:])
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
