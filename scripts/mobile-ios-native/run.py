#!/usr/bin/env python3
"""Run native offline-demo acceptance only on an owned ephemeral macOS runner."""
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "apps/mobile"
HELPERS = Path(__file__).resolve().parent
ACTIVE = set()


def interrupted(_number, _frame):
    raise KeyboardInterrupt("Owned iOS acceptance interrupted")


def group_exists(group):
    try:
        os.killpg(group, 0)
        return True
    except ProcessLookupError:
        return False


def stop_owned_group(child):
    # A joined leader is not evidence that its detached command group is gone.
    for action, bound in ((signal.SIGTERM, 3), (signal.SIGKILL, 3)):
        if not group_exists(child.pid):
            break
        try:
            os.killpg(child.pid, action)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + bound
        while group_exists(child.pid) and time.monotonic() < deadline:
            child.poll()
            time.sleep(0.05)
    child.wait(timeout=3)
    if group_exists(child.pid):
        raise RuntimeError("Owned command descendants remain after bounded cleanup.")


def recovered_creation(document, runtime, name, device_type, before):
    matches = [entry.get("udid") for entry in document.get("devices", {}).get(runtime, [])
               if entry.get("name") == name and entry.get("deviceTypeIdentifier") == device_type
               and entry.get("udid") not in before]
    if len(matches) != 1 or not isinstance(matches[0], str):
        return None
    return matches[0] if re.fullmatch(r"[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}", matches[0]) else None


def record_command_cleanup_failure(child, arguments, error):
    receipt = {"command": Path(arguments[0]).name, "pid": child.pid,
               "returnCode": child.returncode, "cleanupVerified": False,
               "errorType": type(error).__name__, "errno": getattr(error, "errno", None)}
    try:
        observed = subprocess.run(
            ["/bin/ps", "-g", str(child.pid), "-o", "pid=,ppid=,pgid=,uid=,stat="],
            env=ENV, capture_output=True, text=True, timeout=3)
        receipt["groupInspectionExitCode"] = observed.returncode
        receipt["groupProcesses"] = observed.stdout[-8192:]
    except Exception as inspection_error:
        receipt["inspectionErrorType"] = type(inspection_error).__name__
    # Diagnostics never turn an unknown group into absence or authorize a
    # broader signal. Keep only numeric ownership/state, never command args.
    try:
        with (artifacts / "command-cleanup-failures.jsonl").open("a") as output:
            output.write(json.dumps(receipt) + "\n")
    except OSError:
        pass
    print("OCTANT_COMMAND_CLEANUP_FAILURE " + json.dumps(receipt), flush=True)


def run(arguments, *, cwd=ROOT, timeout=60, capture=False):
    child = subprocess.Popen(arguments, cwd=cwd, env=ENV, start_new_session=True,
                             stdout=subprocess.PIPE if capture else None,
                             text=True)
    ACTIVE.add(child)
    try:
        output, _ = child.communicate(timeout=timeout)
        if child.returncode:
            raise RuntimeError(f"Owned command failed ({child.returncode}): {arguments[0]}")
        return output or ""
    finally:
        try:
            stop_owned_group(child)
        except BaseException as cleanup_error:
            record_command_cleanup_failure(child, arguments, cleanup_error)
            raise
        ACTIVE.remove(child)


if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("This fixture runs only on an owned ephemeral macOS CI runner.")
if Path(os.environ.get("GITHUB_WORKSPACE", "")).resolve() != ROOT:
    raise SystemExit("The fixture must run in its checked-out CI workspace.")
ENV = {name: os.environ[name] for name in (
    "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "DEVELOPER_DIR", "USER", "LOGNAME",
    "RUNNER_TRACKING_ID"
) if name in os.environ}
ENV.update(CI="1", GITHUB_ACTIONS="true", EXPO_NO_TELEMETRY="1",
           EXPO_NO_DOTENV="1", EXPO_OFFLINE="1", NODE_ENV="production",
           OCTANT_MOBILE_PUSH="0")
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
artifacts = Path(os.environ["RUNNER_TEMP"]) / "octant-ios-native-acceptance"
artifacts.mkdir(mode=0o700)
versions = []
for path in Path("/Applications").glob("Xcode*.app"):
    match = re.fullmatch(r"Xcode_(\d+)\.(\d+)(?:\.(\d+))?\.app", path.name)
    if match and int(match[1]) >= 26:
        versions.append((tuple(int(part or 0) for part in match.groups()), path))
if not versions:
    raise SystemExit("No supported release Xcode is installed on this runner.")
ENV["DEVELOPER_DIR"] = str(max(versions)[1] / "Contents/Developer")
run(["xcodebuild", "-version"])
work = Path(tempfile.mkdtemp(prefix="octant-ios-demo-", dir=os.environ["RUNNER_TEMP"]))
device = None
creation_attempted = False
creation_name = "Octant offline acceptance " + uuid.uuid4().hex
before_creation = set()
checks = []
try:
    cli = next((path for path in (APP / "node_modules/expo/bin/cli", ROOT / "node_modules/expo/bin/cli") if path.is_file()), None)
    if cli is None:
        raise RuntimeError("The pinned Expo CLI is unavailable.")
    run(["node", str(cli), "prebuild", "--platform", "ios", "--no-install",
         "--skip-dependency-update", "react,react-native,expo,react-native-web"], cwd=APP, timeout=300)
    ios = APP / "ios"
    podfile = ios / "Podfile"
    helper = str(HELPERS / "prepare.rb")
    source = str(HELPERS / "OfflineDemoTests.swift")
    with podfile.open("a") as output:
        output.write("\nrequire " + json.dumps(helper) + "\n")
        output.write("OctantOfflineNativeTests.prepare(__dir__, " + json.dumps(source) + ")\n")
    run(["pod", "install"], cwd=ios, timeout=900)
    available = json.loads(run(["xcrun", "simctl", "list", "devices", "-j"], timeout=180, capture=True))
    before_creation = {entry["udid"] for entries in available["devices"].values() for entry in entries}
    if any(entry.get("name") == creation_name for entries in available["devices"].values() for entry in entries):
        raise RuntimeError("The task-owned Simulator creation name already exists.")
    candidates = [(runtime, entry) for runtime, entries in available["devices"].items()
                  if ".iOS-" in runtime for entry in entries
                  if entry.get("isAvailable") and entry.get("name", "").startswith("iPhone")]
    if not candidates:
        raise RuntimeError("The hosted runner has no available iPhone runtime.")
    runtime, template = candidates[-1]
    creation_attempted = True
    created = run(["xcrun", "simctl", "create", creation_name, template["deviceTypeIdentifier"], runtime], capture=True).strip()
    if not re.fullmatch(r"[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}", created) or created in before_creation:
        raise RuntimeError("The owned Simulator identifier is invalid.")
    device = created
    run(["xcrun", "simctl", "boot", device])
    run(["xcrun", "simctl", "bootstatus", device, "-b"], timeout=180)
    for label, size, method in (
        ("standard", "large", "testColdDemoReplyForegroundAndReset"),
        ("large-text", "accessibility-extra-large", "testLargeTextEntryAndReply"),
    ):
        run(["xcrun", "simctl", "ui", device, "content_size", size])
        observed_size = run(["xcrun", "simctl", "ui", device, "content_size"], capture=True).strip()
        if observed_size != size:
            raise RuntimeError("The owned Simulator did not adopt the requested system text size.")
        run(["xcodebuild", "test", "-workspace", str(ios / "Octant.xcworkspace"),
             "-scheme", "OctantOfflineNativeTests", "-configuration", "Release",
             "-destination", "id=" + device, "-derivedDataPath", str(work / "derived"),
             "-resultBundlePath", str(artifacts / (label + ".xcresult")),
             "-parallel-testing-enabled", "NO", "-test-timeouts-enabled", "YES",
             "-maximum-test-execution-time-allowance", "180",
             "-only-testing:OctantOfflineNativeTests/OfflineDemoTests/" + method,
             "CODE_SIGNING_ALLOWED=NO"], timeout=1800)
        checks.append({"scenario": label, "systemTextSize": observed_size})
    (artifacts / "acceptance.json").write_text(json.dumps({
        "checks": checks, "simulator": device, "runtime": runtime,
        "nativeUi": True, "screenshotProtectionChanged": False,
        "pairedVault": "not-run", "physicalDevice": "not-run", "clientStreaming": "not-run",
    }, indent=2) + "\n")
finally:
    try:
        if creation_attempted and device is None:
            observed = json.loads(run(["xcrun", "simctl", "list", "devices", "-j"], capture=True))
            device = recovered_creation(observed, runtime, creation_name,
                                        template["deviceTypeIdentifier"], before_creation)
            if device is None:
                (artifacts / "cleanup.json").write_text(json.dumps({
                    "ownedSimulatorAbsent": False, "creationUncertain": True,
                    "taskCreationName": creation_name,
                }) + "\n")
                raise RuntimeError("Uncertain Simulator creation has no unique owned UUID; cleanup is unverified.")
        if device is not None:
            try:
                run(["xcrun", "simctl", "shutdown", device], timeout=30)
            except RuntimeError:
                # A failed boot or the test runner may already have stopped it.
                # Delete only the UUID this fixture created, then verify absence.
                pass
            run(["xcrun", "simctl", "delete", device], timeout=30)
            remaining = run(["xcrun", "simctl", "list", "devices", "-j"], capture=True)
            if device in remaining:
                raise RuntimeError("Owned Simulator cleanup is incomplete.")
        if ACTIVE:
            raise RuntimeError("Owned build/test command cleanup is incomplete.")
        (artifacts / "cleanup.json").write_text(json.dumps({
            "ownedSimulatorAbsent": True, "ownedCommandsJoined": True,
        }) + "\n")
    finally:
        if not ACTIVE:
            shutil.rmtree(work)
