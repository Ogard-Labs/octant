#!/usr/bin/env python3
"""Read-only prerequisites for a possible original-inode policy probe."""
import gzip
import json
import platform
import sys
from pathlib import Path

if len(sys.argv) != 2 or sys.platform != 'linux':
    raise SystemExit('usage on Linux: kernel_prerequisites.py evidence.json')

result = {'kernel': platform.release(), 'productionReady': False, 'policyLoaded': False}
try:
    result['activeLsMs'] = Path('/sys/kernel/security/lsm').read_text().strip().split(',')
except OSError as error:
    result['activeLsMs'] = []
    result['lsmReadError'] = str(error)
result['bpfLsmActive'] = 'bpf' in result['activeLsMs']
result['btfPresent'] = Path('/sys/kernel/btf/vmlinux').is_file()
config = ''
for path in (Path('/boot') / ('config-' + platform.release()), Path('/proc/config.gz')):
    try:
        with gzip.open(path, 'rt') if path.suffix == '.gz' else path.open() as stream:
            config = stream.read()
        result['configSource'] = str(path)
        break
    except OSError:
        pass
result['kernelConfig'] = {
    name: next((line.split('=', 1)[1] for line in config.splitlines() if line.startswith(name + '=')), None)
    for name in ('CONFIG_BPF_LSM', 'CONFIG_DEBUG_INFO_BTF', 'CONFIG_SECURITY_APPARMOR')
}
result['status'] = 'eligible-for-capability-probe' if result['bpfLsmActive'] and result['btfPresent'] else 'blocked'
result['nextAction'] = 'No policy loaded. Missing active BPF LSM requires another approved environment; no boot setting is changed.'
Path(sys.argv[1]).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
