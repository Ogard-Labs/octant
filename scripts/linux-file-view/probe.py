"""Bounded native file-view measurements against disposable files only."""
import ctypes
import errno
import json
import os
from pathlib import Path
import select
import signal
import shutil
import subprocess
import sys
import tempfile
import time

CLIENT = r'''
import json,os,sys
held={}
for line in sys.stdin:
 try:
  x=json.loads(line);path=x['path'];op=x['op']
  if op=='read':result=open(path).read()
  elif op=='hold':held[path]=os.open(path,os.O_RDONLY);result='held'
  elif op=='held':result=os.pread(held[path],4096,0).decode()
  elif op=='write':
   with open(path,'w') as f:f.write(x['value']);f.flush();os.fsync(f.fileno())
   result='written'
  elif op=='rename':os.rename(path,x['target']);result='renamed'
  elif op=='watch':
   import ctypes
   libc=ctypes.CDLL(None,use_errno=True)
   fd=libc.inotify_init1(os.O_NONBLOCK|os.O_CLOEXEC)
   if fd<0:raise OSError(ctypes.get_errno(),'inotify_init1')
   if libc.inotify_add_watch(fd,path.encode(),0x100)<0:raise OSError(ctypes.get_errno(),'inotify_add_watch')
   held['watch']=fd;result='watching'
  elif op=='events':
   try:result=bool(os.read(held['watch'],4096))
   except BlockingIOError:result=False
  else:raise ValueError('Unknown fixture operation')
  print(json.dumps({'value':result}),flush=True)
 except OSError as e:print(json.dumps({'error':e.errno}),flush=True)
 except Exception as e:print(json.dumps({'failure':str(e)}),flush=True)
'''

# The owner intentionally has no finally block: the native fixture must survive
# neither this process's SIGKILL nor death before its child reaches exec.
LIFECYCLE_OWNER = r'''
import ctypes,json,os,signal,sys
from pathlib import Path
signal.alarm(15)
expected=int(sys.argv[6])
if os.getppid()!=expected or ctypes.CDLL(None).prctl(1,signal.SIGKILL,0,0,0) or os.getppid()!=expected:
 sys.exit(2)
owner=os.getpid()
gate_read,gate_write=os.pipe()
ready_read,ready_write=os.pipe()
pid=os.fork()
if pid==0:
 signal.alarm(10)
 os.close(gate_write);os.close(ready_read)
 os.write(ready_write,b'R');os.close(ready_write)
 if sys.argv[4]=='startup':os.read(gate_read,1)
 os.close(gate_read)
 null=os.open('/dev/null',os.O_RDWR)
 for fd in (0,1,2):os.dup2(null,fd)
 if null>2:os.close(null)
 os.execve(sys.argv[1],[sys.argv[1],sys.argv[2],sys.argv[3],str(owner),sys.argv[5]],
           {'PATH':'/usr/bin:/bin','LANG':'C'})
os.close(gate_read);os.close(ready_write)
if os.read(ready_read,1)!=b'R':sys.exit(2)
os.close(ready_read)
birth=Path('/proc/%s/stat'%pid).read_text().rpartition(')')[2].split()[19]
print(json.dumps({'pid':pid,'birth':birth,'preExecReady':True}),flush=True)
joined,status=os.waitpid(pid,0)
print(json.dumps({'joined':joined,'status':status}),flush=True)
signal.pause()
'''

state = {'kind': 'native-feasibility-only', 'started': time.time(), 'measurements': [],
         'productionReady': False, 'limits': [
             'Synthetic fixture policy, not the production effective policy compiler',
             'No production launch wiring, provider or credential acceptance',
             'Not proof of all aliases, concurrency, watches or failure modes']}
owned = []
root = None
mount = None
temporary = None
fixture_identity = None
lifecycle_mounts = []
lifecycle_cleanup = True
subreaper_prior = None

def stop(signum, frame):
    raise TimeoutError('Bounded native fixture stopped')

for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
    signal.signal(sig, stop)
signal.alarm(120)

def launch(argv, **options):
    process = subprocess.Popen(argv, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}, **options)
    identity = Path('/proc/%s/stat' % process.pid).read_text().split(') ', 1)[1].split()[19]
    owned.append((process, identity))
    return process

def request(operation, path, **other):
    if client.poll() is not None:
        raise RuntimeError('Owned namespace client exited: '+client.stderr.read()[:500])
    client.stdin.write(json.dumps(dict(op=operation, path=str(path), **other))+'\n')
    client.stdin.flush()
    if not select.select([client.stdout], [], [], 5)[0]:
        raise TimeoutError('Bounded namespace operation exceeded five seconds')
    line = client.stdout.readline()
    if not line:
        raise RuntimeError('No client result: '+client.stderr.read()[:500])
    return json.loads(line)

def case(name, result, expected):
    state['measurements'].append(dict(name=name, passed=result==expected, observed=result, expected=expected))

def mounted(path):
    # Inspect the mount table, not a potentially dead FUSE mount's contents.
    return any(line.split()[4] == str(path) for line in Path('/proc/self/mountinfo').read_text().splitlines())

def birth(pid):
    try:return Path('/proc/%s/stat'%pid).read_text().rpartition(')')[2].split()[19]
    except FileNotFoundError:return None

def retire_fixture_children():
    # Called only after every retained Popen child has been waited. The remaining
    # direct children are this probe's adopted FUSE mount-retirement descendants.
    known = {}
    until = time.monotonic()+3
    force_after = time.monotonic()+1
    while time.monotonic()<until:
        children = Path('/proc/self/task/%s/children'%os.getpid()).read_text().split()
        if not children:return True
        if len(children)>32:return False
        for value in children:
            pid = int(value)
            identity = birth(pid)
            if identity is None:continue
            if pid in known and known[pid]!=identity:return False
            known[pid] = identity
            reaped, _ = os.waitpid(pid, os.WNOHANG)
            if reaped == pid:continue
            if time.monotonic()>=force_after and birth(pid)==identity:
                os.kill(pid, signal.SIGKILL)
        time.sleep(.02)
    return False

def lifecycle(executable, base):
    global lifecycle_cleanup, subreaper_prior
    libc = ctypes.CDLL(None, use_errno=True)
    prior = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(prior), 0, 0, 0) or libc.prctl(36, 1, 0, 0, 0):
        raise RuntimeError('Task-local child reaping is unavailable')
    subreaper_prior = prior.value
    measurements = []
    for purpose in ('owner-loss', 'startup', 'deadline'):
        prior_cleanup = lifecycle_cleanup
        lifecycle_cleanup = False
        directory = base/purpose
        backing, view = directory/'backing', directory/'view'
        backing.mkdir(parents=True);view.mkdir()
        lifecycle_mounts.append(view)
        known, joined = {}, {}
        owner = None
        measurement = {'name': purpose, 'passed': False}

        def observe():
            children = Path('/proc/self/task/%s/children'%os.getpid()).read_text().split()
            if len(children)>32:raise RuntimeError('Owned child census exceeded its bound')
            for value in children:
                pid = int(value)
                if owner is not None and pid == owner.pid:continue
                identity = birth(pid)
                if identity is not None:
                    if pid in known and known[pid] != identity:
                        raise RuntimeError('Owned child identity changed')
                    known[pid] = identity
            for pid in known:
                if pid in joined:continue
                try:
                    reaped, status = os.waitpid(pid, os.WNOHANG)
                    if reaped == pid:joined[pid] = status
                except ChildProcessError:pass

        def children_left():
            return bool(Path('/proc/self/task/%s/children'%os.getpid()).read_text().strip())

        def reply():
            if not select.select([owner.stdout], [], [], 3)[0]:
                raise TimeoutError('Owned fixture owner did not answer')
            line = owner.stdout.readline(1024)
            if not line or len(line)>=1024:raise RuntimeError('Invalid owner receipt')
            return json.loads(line)

        try:
            seconds = '2' if purpose == 'deadline' else '10'
            owner = launch([sys.executable, '-u', '-c', LIFECYCLE_OWNER,
                            executable, str(backing), str(view), purpose, seconds,str(os.getpid())],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
            receipt = reply()
            pid, identity = receipt['pid'], receipt['birth']
            if not isinstance(pid,int) or pid<2 or birth(pid)!=identity:
                raise RuntimeError('Owned fixture identity unavailable')
            known[pid] = identity
            if purpose == 'startup':
                if receipt.get('preExecReady') is not True or mounted(view):
                    raise RuntimeError('Pre-exec owner-death gate was not established')
            else:
                deadline = time.monotonic()+5
                while time.monotonic()<deadline and not mounted(view):
                    if owner.poll() is not None or birth(pid)!=identity:
                        raise RuntimeError('Owned FUSE fixture exited before mounting')
                    time.sleep(.02)
                if not mounted(view):raise TimeoutError('Owned FUSE mount did not appear')

            if purpose == 'deadline':
                ended = reply()
                if ended.get('joined')!=pid:raise RuntimeError('Wrong native wait receipt')
                joined[pid] = ended['status']
                measurement['ownerStillAlive'] = owner.poll() is None
                owner.terminate();owner.wait(timeout=2)
            else:
                owner.kill();owner.wait(timeout=2)
                measurement['ownerKilled'] = owner.returncode == -signal.SIGKILL

            deadline = time.monotonic()+3
            while time.monotonic()<deadline:
                observe()
                if pid in joined and not mounted(view) and len(joined)==len(known) and not children_left():break
                time.sleep(.02)
            measurement.update(helperJoined=pid in joined, mountRemoved=not mounted(view),
                               allChildrenJoined=len(joined)==len(known) and not children_left())
            status = joined.get(pid)
            expected = (status is not None and
                        (os.WIFEXITED(status) and os.WEXITSTATUS(status)==2 if purpose=='startup'
                         else os.WIFSIGNALED(status) and os.WTERMSIG(status)==signal.SIGKILL))
            measurement['passed'] = (expected and measurement['helperJoined'] and
                measurement['mountRemoved'] and measurement['allChildrenJoined'] and
                measurement.get('ownerStillAlive', measurement.get('ownerKilled', False)))
        except Exception as error:
            measurement['failure'] = type(error).__name__
        finally:
            # Fallback cleanup cannot turn a failed lifecycle observation into a pass.
            if owner is not None and owner.poll() is None:
                if birth(owner.pid) != next(identity for process,identity in owned if process is owner):
                    raise RuntimeError('Owner identity changed before cleanup')
                owner.kill();owner.wait(timeout=2)
            if mounted(view):
                subprocess.run(['fusermount3','-uz',str(view)],capture_output=True,timeout=3)
            deadline = time.monotonic()+3
            while time.monotonic()<deadline:
                observe()
                for pid,identity in known.items():
                    if pid not in joined and birth(pid)==identity:os.kill(pid,signal.SIGKILL)
                if len(joined)==len(known) and not mounted(view) and not children_left():break
                time.sleep(.02)
            observe()
            cleaned = len(joined)==len(known) and not mounted(view) and not children_left()
            lifecycle_cleanup = prior_cleanup and cleaned
            measurement['cleanupConfirmed'] = cleaned
            if owner is not None:owner.stdout.close()
        measurements.append(measurement)
        if not lifecycle_cleanup:break
    return measurements

try:
    if sys.platform != 'linux' or len(sys.argv) != 3:
        raise RuntimeError('usage: probe.py native-fixture-binary evidence.json (Linux only)')
    evidence = Path(sys.argv[2]).resolve()
    state['kernel'] = os.uname().release
    state['bwrap'] = subprocess.check_output(['bwrap', '--version'], text=True, timeout=3).strip()
    temporary = tempfile.mkdtemp(prefix='octant-file-view-')
    fixture_identity = os.stat(temporary)
    root = Path(temporary)/'backing';mount = Path(temporary)/'view'
    for p in [root, mount, root/'.ssh', root/'.provider/accounts/first', root/'.provider/accounts/second']:
        p.mkdir(parents=True,exist_ok=True)
    executable = str(Path(sys.argv[1]).resolve())
    state['lifecycleMeasurements'] = lifecycle(executable, Path(temporary)/'lifecycle')
    if len(state['lifecycleMeasurements'])!=3 or not all(x['passed'] and x['cleanupConfirmed'] for x in state['lifecycleMeasurements']):
        raise RuntimeError('Native FUSE owner-death, startup or lifetime check failed')
    (root/'.ssh/custom').write_text('public-before-companion')
    (root/'.provider/accounts/first/token').write_text('synthetic-own-account')
    (root/'.provider/accounts/second/token').write_text('synthetic-other-account')
    mediator = launch([executable, str(root), str(mount), str(os.getpid()), '120'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    deadline=time.monotonic()+10
    while time.monotonic()<deadline:
        if subprocess.run(['mountpoint','-q',str(mount)],timeout=2).returncode==0:break
        if mediator.poll() is not None:raise RuntimeError('Mediator startup failed: '+mediator.stderr.read()[:500])
        time.sleep(.1)
    else:raise TimeoutError('No task-owned mediated mount appeared')
    client=launch(['bwrap','--unshare-all','--die-with-parent','--new-session','--ro-bind','/','/',
                  '--bind',str(mount),str(root),'--proc','/proc','--dev','/dev','--',
                  '/usr/bin/python3','-u','-c',CLIENT],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
    case('open allowed descriptor before companion creation', request('hold',root/'.ssh/custom'), {'value':'held'})
    (root/'.ssh/id_late').write_text('synthetic-secret')
    case('deny exact protected path created after runtime start',request('read',root/'.ssh/id_late'),{'error':errno.EACCES})
    (root/'.ssh/notes.txt').write_text('outside-live')
    case('see permitted outside sibling created after runtime start',request('read',root/'.ssh/notes.txt'),{'value':'outside-live'})
    case('write a permitted file',request('write',root/'.ssh/result.txt',value='persisted'),{'value':'written'})
    case('persist permitted bytes in real backing storage',(root/'.ssh/result.txt').read_text(),'persisted')
    case('rename a permitted file',request('rename',root/'.ssh/result.txt',target=str(root/'.ssh/renamed.txt')),{'value':'renamed'})
    case('persist permitted rename',(root/'.ssh/renamed.txt').read_text(),'persisted')
    (root/'.ssh/custom.pub').write_text('synthetic-public-companion')
    case('deny late companion-derived secret',request('read',root/'.ssh/custom'),{'error':errno.EACCES})
    case('recheck already open descriptor after companion arrives',request('held',root/'.ssh/custom'),{'error':errno.EACCES})
    case('preserve synthetic own-account exception',request('read',root/'.provider/accounts/first/token'),{'value':'synthetic-own-account'})
    case('deny synthetic other account',request('read',root/'.provider/accounts/second/token'),{'error':errno.EACCES})
    (root/'secret-link').symlink_to('.ssh/id_late')
    case('deny symbolic alias to protected file',request('read',root/'secret-link'),{'error':errno.EACCES})
    (root/'allowed-link').symlink_to('.ssh/notes.txt')
    case('preserve permitted symbolic alias',request('read',root/'allowed-link'),{'value':'outside-live'})
    os.link(root/'.ssh/id_late',root/'secret-hard-link')
    case('deny hard-link alias to protected file',request('read',root/'secret-hard-link'),{'error':errno.EACCES})
    os.link(root/'.ssh/notes.txt',root/'allowed-hard-link')
    case('preserve permitted hard links',request('read',root/'allowed-hard-link'),{'value':'outside-live'})
    case('start real inotify watch',request('watch',root/'.ssh'),{'value':'watching'})
    (root/'.ssh/from-outside.txt').write_text('outside-watch')
    time.sleep(.3)
    case('deliver permitted backing-file creation to watcher',request('events',root/'.ssh'),{'value':True})
    state['status']='measured'
    state['selectedMechanismChecksPassed']=all(x['passed'] for x in state['measurements'])
    # Owned resources are stopped before TemporaryDirectory removes backing files.
    for process,identity in reversed(owned):
        if process.poll() is None:
            current=Path('/proc/%s/stat'%process.pid).read_text().split(') ',1)[1].split()[19]
            if current!=identity:raise RuntimeError('Owned process identity changed')
            process.terminate()
            try:process.wait(timeout=3)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)
    unmount=subprocess.run(['fusermount3','-u',str(mount)],capture_output=True,text=True,timeout=3)
    if subprocess.run(['mountpoint','-q',str(mount)],timeout=2).returncode==0:
        raise RuntimeError('Owned mount did not stop')
    state['cleanup']={'processesExited':all(p.poll() is not None for p,_ in owned),'mountRemoved':True}
except Exception as error:
    state['status']='blocked';state['failure']=str(error)
finally:
    signal.alarm(0)
    for process,identity in reversed(owned):
        if process.poll() is None:
            try:
                current=Path('/proc/%s/stat'%process.pid).read_text().split(') ',1)[1].split()[19]
                if current==identity:
                    process.terminate()
                    try:process.wait(timeout=3)
                    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)
            except (OSError,ProcessLookupError):pass
    if mount and mounted(mount):
        subprocess.run(['fusermount3','-uz',str(mount)],capture_output=True,timeout=3)
    if subreaper_prior is not None:
        try:
            lifecycle_cleanup = (not any(process.poll() is None for process,_ in owned)
                                 and retire_fixture_children() and lifecycle_cleanup)
        except (OSError, RuntimeError):
            lifecycle_cleanup = False
        if ctypes.CDLL(None).prctl(36, subreaper_prior, 0, 0, 0):
            lifecycle_cleanup = False
    still_mounted = bool(mount and mounted(mount)) or any(mounted(view) for view in lifecycle_mounts)
    remaining = [process.pid for process,_ in owned if process.poll() is None]
    state.setdefault('cleanup',{}).update(processesExited=not remaining and lifecycle_cleanup,remainingOwnedPids=remaining,mountRemoved=not still_mounted,lifecycleCleanupConfirmed=lifecycle_cleanup)
    if temporary and fixture_identity:
        now = os.lstat(temporary)
        if (now.st_dev,now.st_ino)==(fixture_identity.st_dev,fixture_identity.st_ino) and not still_mounted and not remaining and lifecycle_cleanup:
            shutil.rmtree(temporary)
            state.setdefault('cleanup',{})['fixtureRemoved']=True
        else:
            state['status']='blocked';state['failure']='Owned fixture identity or mount cleanup unconfirmed'
    state['finished']=time.time()
    if len(sys.argv)==3:
        Path(sys.argv[2]).write_text(json.dumps(state,indent=2))
    print(json.dumps(state))
    cleanup = state.get('cleanup',{})
    sys.exit(0 if state.get('status')=='measured' and all(cleanup.get(field) for field in
             ('processesExited','mountRemoved','fixtureRemoved','lifecycleCleanupConfirmed')) else 1)
