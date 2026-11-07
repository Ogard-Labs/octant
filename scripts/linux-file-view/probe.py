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
    (root/'.ssh/custom').write_text('public-before-companion')
    (root/'.provider/accounts/first/token').write_text('synthetic-own-account')
    (root/'.provider/accounts/second/token').write_text('synthetic-other-account')
    mediator = launch([str(Path(sys.argv[1]).resolve()), str(root), str(mount)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
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
    if mount and mount.exists():
        subprocess.run(['fusermount3','-uz',str(mount)],capture_output=True,timeout=3)
    if temporary and fixture_identity:
        now = os.lstat(temporary)
        still_mounted = mount and subprocess.run(['mountpoint','-q',str(mount)],timeout=2).returncode==0
        if (now.st_dev,now.st_ino)==(fixture_identity.st_dev,fixture_identity.st_ino) and not still_mounted:
            shutil.rmtree(temporary)
            state.setdefault('cleanup',{})['fixtureRemoved']=True
        else:
            state['status']='blocked';state['failure']='Owned fixture identity or mount cleanup unconfirmed'
    state['finished']=time.time()
    if len(sys.argv)==3:
        Path(sys.argv[2]).write_text(json.dumps(state,indent=2))
    print(json.dumps(state))
    sys.exit(0 if state.get('status')=='measured' and state.get('cleanup',{}).get('mountRemoved') else 1)
