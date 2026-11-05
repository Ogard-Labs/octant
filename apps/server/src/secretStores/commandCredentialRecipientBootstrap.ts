/** Fixed host code rechecks canonical path, SHA-256 and stat identity after auth waits.
 * Positional inputs are recipient path, digest, identity, then reviewed arguments.
 * Keep this literal below the process port's 1024-byte argument bound; reads stay
 * bounded to 64 MiB. A refusal exits silently. The final check-to-exec syscall
 * race remains: this is not an executable-fd launch. Runtime loader variables
 * are excluded before bootstrap startup and removed before the recipient.
 */
export const COMMAND_CREDENTIAL_RECIPIENT_BOOTSTRAP =
  'try {\nconst fs=require("node:fs"),crypto=require("node:crypto");\nconst [path,digest,pin,...args]=process.argv.slice(1);\nconst id=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(":");\nconst fail=()=>process.exit(126);\nif(typeof process.execve!=="function"||fs.realpathSync(path)!==path)fail();\nconst fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),s=fs.fstatSync(fd);\nif(!s.isFile()||s.size>67108864||id(s)!==pin)fail();\nconst hash=crypto.createHash("sha256"),b=Buffer.alloc(65536);let size=0,n;\nwhile(n=fs.readSync(fd,b,0,b.length,null)){size+=n;if(size>67108864)fail();hash.update(b.subarray(0,n))}\nif(hash.digest("hex")!==digest||id(fs.fstatSync(fd))!==pin||id(fs.statSync(path))!==pin)fail();\nfs.closeSync(fd);\nconst env={...process.env};for(const k of Object.keys(env))if(/^(NODE_|BUN_|ELECTRON_)/.test(k))delete env[k];\nprocess.execve(path,[path,...args],env);\n}catch{process.exit(126)}';
