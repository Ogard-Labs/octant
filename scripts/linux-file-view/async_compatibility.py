"""No-auth runtime compatibility measurements with process-owned syscall refusal."""
import errno
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile


def interrupted(number, frame):
    raise TimeoutError('Bounded compatibility proof interrupted')


for number in (signal.SIGALRM, signal.SIGINT, signal.SIGTERM):
    signal.signal(number, interrupted)
signal.alarm(90)
temporary = Path(tempfile.mkdtemp(prefix='octant-async-compatibility-'))
identity = temporary.stat()
state = {'kind': 'async-refusal-compatibility', 'productionReady': False,
         'kernel': os.uname().release, 'measurements': [], 'limits': [
             'No filesystem admission policy or production launch wiring',
             'Version/help startup does not establish authenticated provider behavior',
             'Synthetic standard file operations do not prove all runtime paths']}
active = None


def run(arguments, environment, directory, timeout=10):
    global active
    active = subprocess.Popen(arguments, env=environment, cwd=directory,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, start_new_session=True)
    try:
        output, errors = active.communicate(timeout=timeout)
        return {'exit': active.returncode, 'stdout': output[:4000], 'stderr': errors[:2000]}
    finally:
        # The retained leader is not reaped until communicate/wait; its group is task-owned.
        if active.poll() is None:
            os.killpg(active.pid, signal.SIGKILL)
            active.wait(timeout=3)
        active = None


try:
    checker, bun, provider_root, evidence = map(Path, sys.argv[1:])
    checker = checker.resolve()
    bun = bun.resolve()
    source = Path(__file__).with_suffix('.mjs').resolve()
    node = Path(shutil.which('node')).resolve()
    providers = [
        ('claude-agent-sdk-0.3.211', provider_root/'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'),
        ('codex-0.164.0', provider_root/'node_modules/.bin/codex'),
    ]
    base_environment = {'PATH': str(bun.parent)+':/usr/local/bin:/usr/bin:/bin',
                        'LANG': 'C', 'HOME': str(temporary), 'XDG_CONFIG_HOME': str(temporary/'config'),
                        'XDG_CACHE_HOME': str(temporary/'cache'), 'CODEX_HOME': str(temporary/'codex'),
                        'CLAUDE_CONFIG_DIR': str(temporary/'claude'),
                        'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1',
                        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
    bwrap = shutil.which('bwrap')
    capsule = ([bwrap, '--unshare-all', '--die-with-parent', '--new-session',
                '--ro-bind', '/', '/', '--bind', str(temporary), str(temporary),
                '--proc', '/proc', '--dev', '/dev', '--'] if bwrap else [])
    prerequisite = run(capsule+['/bin/true'], base_environment, temporary) if bwrap else {'exit': 127, 'stderr': 'Bubblewrap absent'}
    state['bubblewrap'] = prerequisite
    if prerequisite['exit'] != 0:
        capsule = []
    for name, number in [('EPERM', errno.EPERM), ('ENOSYS', errno.ENOSYS)]:
        prefix = capsule+[str(checker), name]
        for runtime_name, runtime in [('bun-1.4.4', bun), ('node-runner', node)]:
            directory = temporary/(name+'-'+runtime_name)
            directory.mkdir()
            result = run(prefix+[str(runtime), str(source), str(directory), str(checker), str(number)],
                         base_environment, temporary)
            state['measurements'].append({'name': runtime_name+' native file behavior '+name,
                                          'passed': result['exit'] == 0, 'capsule': bool(capsule), **result})
        for label, executable in providers:
            for option in ['--version', '--help']:
                if not capsule:
                    state['measurements'].append({'name': label+' '+option+' '+name,
                                                  'passed': False, 'blocked': 'No network-isolated Bubblewrap capsule'})
                    continue
                result = run(prefix+[str(executable.resolve()), option], base_environment, temporary)
                state['measurements'].append({'name': label+' '+option+' '+name,
                                              'passed': result['exit'] == 0, 'capsule': True, **result})
    state['status'] = 'measured' if all(item['passed'] for item in state['measurements']) else 'blocked'
except Exception as error:
    state['status'] = 'blocked'
    state['failure'] = str(error)
finally:
    signal.alarm(0)
    if active is not None and active.poll() is None:
        os.killpg(active.pid, signal.SIGKILL)
        active.wait(timeout=3)
    current = temporary.stat()
    if current.st_dev == identity.st_dev and current.st_ino == identity.st_ino:
        shutil.rmtree(temporary)
        state['cleanup'] = {'ownedLeaderReaped': active is None or active.poll() is not None,
                            'fixtureRemoved': not temporary.exists()}
    else:
        state['status'] = 'blocked'
        state['failure'] = 'Owned fixture directory identity changed'
    Path(sys.argv[4]).write_text(json.dumps(state, indent=2))
    print(json.dumps(state))
    sys.exit(0 if state['status'] == 'measured' else 1)
