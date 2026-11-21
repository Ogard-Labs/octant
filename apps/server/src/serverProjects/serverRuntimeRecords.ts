import { createHash, randomBytes } from "node:crypto";
import type { ServerAddress, ServerConnection, ServerStreamInput } from "./serverConnection";

/**
 * The provider programs this host started on servers, recorded there so one
 * left running after its connection dropped is stopped later. Canonical:
 * docs/design/server-projects.md § Providers running on the server.
 *
 * Closing a stream's standard input ends a program that reads it, but a
 * dropped connection, or a program that ignores the end of its input, can
 * leave the program running on the server with nothing here holding it. So
 * every placed program starts behind a shell that writes its PID and start
 * identity to a private file under the login's own state, then `exec`s the
 * program, which keeps both. A later sweep stops a recorded program only when
 * its PID is alive with the start identity it recorded: a PID the server has
 * since given to another program fails that test and is left running.
 *
 * Each record's name carries this host's tag, so a sweep touches only records
 * this host made, and this run's id with a sequence, so a sweep touches a
 * record of this run only once its stream has ended here. A record of an
 * earlier run of this host is always swept: that run's connections ended
 * with it.
 */

/** Where records live: under the server login's own home, readable only by it. */
const RECORDS_FOLDER = '"${HOME:?}/.octant/server-runtimes"';

/**
 * Prints a process's start identity: on Linux the boot id with the start
 * time in clock ticks (field 22 of `/proc/<pid>/stat`, read after the last
 * `)` since the command name may hold spaces), elsewhere `ps`'s full start
 * time. Empty when the process is gone.
 */
const STARTED_OF = `started_of() {
  if [ -r "/proc/$1/stat" ]; then
    printf '%s/%s\\n' "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" "$(sed 's/.*) //' "/proc/$1/stat" | cut -d' ' -f20)"
  else
    ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'
  fi
}`;

/**
 * Runs in the Project's folder: `$1` the folder, `$2` the record's name, the
 * rest the program. The record is written in a subshell so the private umask
 * never reaches the program; `$$` there is still this shell, which the
 * `exec` turns into the program. A program that cannot be recorded does not
 * start, since nothing could stop it after a dropped connection.
 */
const RECORDED_START_SCRIPT = `${STARTED_OF}
cd "$1" || exit 1
record=$2
shift 2
(
  umask 077
  dir=${RECORDS_FOLDER}
  mkdir -p "$dir" || exit 1
  started=$(started_of $$)
  [ -n "$started" ] || exit 1
  printf '%s %s\\n' "$$" "$started" > "$dir/$record"
) || { echo "Octant could not record this program on the server, so it did not start." >&2; exit 1; }
exec "$@"`;

/** How long a stopped program has to exit after TERM before it is killed. */
const SWEEP_GRACE_SECONDS = 5;
const SWEEP_TIMEOUT_MS = 30_000;

/**
 * `$1` this host's tag, `$2` this run's id, the rest the sequences of this
 * run whose streams have ended. Every record of the tag from another run, and
 * every ended one of this run, is a candidate: one whose PID is alive (not a
 * zombie) with its recorded start identity gets TERM, then KILL after the
 * grace if it is still that process; then the record is removed.
 */
const SWEEP_SCRIPT = `${STARTED_OF}
dir=${RECORDS_FOLDER}
[ -d "$dir" ] || exit 0
tag=$1
run=$2
shift 2
ended=" $* "
records=
for record in "$dir/$tag".*; do
  [ -f "$record" ] || continue
  name=\${record##*/}
  name=\${name#"$tag".}
  case "$name" in *[!0-9a-f.]*) continue ;; esac
  case "$name" in
    "$run".*) case "$ended" in *" \${name#"$run".} "*) ;; *) continue ;; esac ;;
  esac
  records="$records $name"
done
[ -n "$records" ] || exit 0
running() {
  pid=
  started=
  read -r pid started < "$dir/$tag.$1" || [ -n "$pid" ] || return 1
  case "$pid" in "" | *[!0-9]*) return 1 ;; esac
  [ -n "$started" ] && kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/stat" ] && [ "$(sed 's/.*) //' "/proc/$pid/stat" | cut -d' ' -f1)" = Z ]; then return 1; fi
  [ "$(started_of "$pid")" = "$started" ]
}
signal() {
  for name in $records; do
    if running "$name"; then kill -s "$1" "$pid" 2>/dev/null; fi
  done
}
any_running() {
  for name in $records; do
    if running "$name"; then return 0; fi
  done
  return 1
}
signal TERM
waited=0
while [ "$waited" -lt ${SWEEP_GRACE_SECONDS} ] && any_running; do
  sleep 1
  waited=$((waited + 1))
done
signal KILL
for name in $records; do rm -f "$dir/$tag.$name"; done
exit 0`;

/** One login's records as this run knows them: those whose streams ended, and whether a sweep has run. */
interface LoginRecords {
  readonly ended: Set<number>;
  swept: boolean;
  sweeping: boolean;
  /** A sweep was asked for while one was running, so another follows it. */
  again: boolean;
}

/** A placed program's start, recorded under a name of its own. */
export interface RecordedStart {
  readonly input: ServerStreamInput;
  /**
   * Called once the stream has closed, with the exit code ssh reported. A
   * stream that ended without the program's own exit code (no code, or ssh's
   * own 255) may have left the program running, so it is swept at once.
   */
  readonly ended: (exitCode: number | null) => void;
}

export interface ServerRuntimeRecordsOptions {
  readonly connection: Pick<ServerConnection, "run">;
  /** This host's stable id, read on the first start; only its digest reaches a server. */
  readonly hostId: () => string;
}

export class ServerRuntimeRecords {
  readonly #connection: Pick<ServerConnection, "run">;
  readonly #hostId: () => string;
  readonly #run = randomBytes(8).toString("hex");
  readonly #logins = new Map<string, LoginRecords>();
  #tag: string | undefined;
  #sequence = 0;

  constructor(options: ServerRuntimeRecordsOptions) {
    this.#connection = options.connection;
    this.#hostId = options.hostId;
  }

  /**
   * A program about to start on the server, in the folder: its stream's
   * script and arguments, which record it before it runs. A sweep of the
   * login's stale records runs beside it when one is due; this start's own
   * record is never among them, since its stream has not ended.
   */
  begin(server: ServerAddress, folder: string, program: ReadonlyArray<string>): RecordedStart {
    this.connected(server);
    const sequence = ++this.#sequence;
    const name = `${this.#hostTag()}.${this.#run}.${sequence}`;
    let ended = false;
    return {
      input: { script: RECORDED_START_SCRIPT, args: [folder, name, ...program] },
      ended: (exitCode) => {
        if (ended) return;
        ended = true;
        const login = this.#login(server);
        login.ended.add(sequence);
        if (exitCode === null || exitCode === 255) this.#sweep(server, login);
      },
    };
  }

  /** A call is about to reach the server: the login's stale records are swept if a sweep is due. */
  connected(server: ServerAddress): void {
    const login = this.#login(server);
    if (!login.swept || login.ended.size > 0) this.#sweep(server, login);
  }

  #sweep(server: ServerAddress, login: LoginRecords): void {
    if (login.sweeping) {
      login.again = true;
      return;
    }
    login.sweeping = true;
    login.again = false;
    const ended = [...login.ended];
    void this.#connection
      .run(server, {
        script: SWEEP_SCRIPT,
        args: [this.#hostTag(), this.#run, ...ended.map(String)],
        timeoutMs: SWEEP_TIMEOUT_MS,
        maxOutputBytes: 4 * 1024,
      })
      .then(
        (call) => call.status === "ran" && call.exitCode === 0,
        () => false,
      )
      .then((swept) => {
        login.sweeping = false;
        // An unreachable server keeps every record due, for the next call.
        if (swept) {
          login.swept = true;
          for (const sequence of ended) login.ended.delete(sequence);
        }
        if (login.again && swept) this.#sweep(server, login);
      });
  }

  #login(server: ServerAddress): LoginRecords {
    const key = `${server.alias}\0${server.user}`;
    const existing = this.#logins.get(key);
    if (existing !== undefined) return existing;
    const created: LoginRecords = { ended: new Set(), swept: false, sweeping: false, again: false };
    this.#logins.set(key, created);
    return created;
  }

  #hostTag(): string {
    this.#tag ??= createHash("sha256")
      .update("octant.server-runtime-host.v1\0")
      .update(this.#hostId())
      .digest("hex")
      .slice(0, 32);
    return this.#tag;
  }
}
