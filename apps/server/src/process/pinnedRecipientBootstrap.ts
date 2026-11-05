/** Fixed host code rechecks canonical path, SHA-256 and stat identity after auth waits.
 * Positional inputs are recipient path, digest, identity, then reviewed arguments.
 * Keep this literal below the process port's 1024-byte argument bound; reads stay
 * bounded to 64 MiB. A refusal exits silently. The final check-to-exec syscall
 * race remains: this is not an executable-fd launch. Runtime loader variables
 * are excluded before bootstrap startup and removed before the recipient.
 */
function source(confined: boolean): string {
  return `try {
const fs=require("node:fs"),crypto=require("node:crypto");
const [path,digest,pin,...args]=process.argv.slice(1);
const id=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(":");
const fail=()=>process.exit(126);
if(typeof process.execve!=="function"||fs.realpathSync(path)!==path)fail();
const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),s=fs.fstatSync(fd);
if(!s.isFile()||s.size>67108864||id(s)!==pin)fail();
const hash=crypto.createHash("sha256"),b=Buffer.alloc(65536);let size=0,n;
while(n=fs.readSync(fd,b,0,b.length,null)){size+=n;if(size>67108864)fail();hash.update(b.subarray(0,n))}
if(hash.digest("hex")!==digest||id(fs.fstatSync(fd))!==pin||id(fs.statSync(path))!==pin)fail();
fs.closeSync(fd);
const env={...process.env};for(const k of Object.keys(env))if(${confined ? "/^(NODE_(?!USE_ENV_PROXY$)|BUN_|ELECTRON_)/" : "/^(NODE_|BUN_|ELECTRON_)/"}.test(k))delete env[k];
process.execve(path,[path,...args],env);
}catch{process.exit(126)}`;
}

export const COMMAND_CREDENTIAL_RECIPIENT_BOOTSTRAP = source(false);
/** Only host-generated proxy activation survives in the confined child. */
export const CONFINED_CREDENTIAL_RECIPIENT_BOOTSTRAP = source(true);
