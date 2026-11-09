#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <linux/ptrace.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Original bounded scheduling experiment; no pathname or production policy. */
#define TARGET 100
#define PERMITTED 101
#define PROTECTED 102
#define ROUNDS 20
#define MAX_TASKS 16
static const char public_bytes[] = "permitted-native";
static const char secret_bytes[] = "protected-synthetic";
static volatile sig_atomic_t stopped;
struct evidence {
  atomic_int phase, swaps, ready;
  int reads, denied_reads, denied_maps, permitted_maps;
  int admissions, frozen_windows, clone_events, fork_events, vfork_events, exec_events;
  int untraced_refused, clone3_refused, async_refused;
  int traced_tasks, joined_tasks;
  bool ownership_ready, workload_passed, normal_passed, death_passed;
};
struct task { pid_t tid; bool live, parked, admission; int signal, refused; };
static struct evidence *proof;
static void stop(int number) { stopped = number; }
static int64_t now(void) {
  struct timespec value;
  clock_gettime(CLOCK_MONOTONIC, &value);
  return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static bool join_owner(pid_t owner, int *status) {
  for (;;) {
    pid_t joined = waitpid(owner, status, 0);
    if (joined == owner) return true;
    if (joined < 0 && errno == EINTR) {
      if (stopped) kill(owner, SIGKILL);
      continue;
    }
    return false;
  }
}

static void *swapper(void *unused) {
  (void)unused;
  atomic_store(&proof->ready, 1);
  for (int round = 0; round < ROUNDS && !stopped; round++) {
    while (atomic_load(&proof->phase) != round + 1 && !stopped) {}
    if (stopped || dup2(PROTECTED, TARGET) != TARGET) return (void *)1;
    atomic_fetch_add(&proof->swaps, 1);
  }
  return NULL;
}

static void *idle_peer(void *unused) {
  (void)unused;
  for (;;) pause();
  return NULL;
}

static void workload(const char *path, const char *permitted, const char *executable, bool death) {
  int secret = open(path, O_RDONLY);
  int allowed = open(permitted, O_RDONLY);
  if (secret < 0 || allowed < 0 || dup2(secret, PROTECTED) != PROTECTED ||
      dup2(allowed, PERMITTED) != PERMITTED || dup2(allowed, TARGET) != TARGET) _exit(2);
  if (secret != PROTECTED && secret != PERMITTED && secret != TARGET) close(secret);
  if (allowed != PROTECTED && allowed != PERMITTED && allowed != TARGET) close(allowed);
  pthread_t peer;
  if (pthread_create(&peer, NULL, death ? idle_peer : swapper, NULL)) _exit(3);
  if (death) {
    pid_t child = fork();
    if (child < 0) _exit(3);
    if (child == 0) { for (;;) pause(); }
    atomic_store(&proof->ready, 1);
    syscall(SYS_getppid);
    for (;;) pause();
  }
  while (!atomic_load(&proof->ready)) {}
  char bytes[64];
  for (int round = 0; round < ROUNDS; round++) {
    if (dup2(PERMITTED, TARGET) != TARGET) _exit(4);
    ssize_t amount = pread(TARGET, bytes, sizeof(bytes), 0);
    if (amount != (ssize_t)sizeof(public_bytes) - 1 || memcmp(bytes, public_bytes, amount)) _exit(5);
    proof->reads++;
    while (atomic_load(&proof->swaps) != round + 1) {}
    if (pread(TARGET, bytes, sizeof(bytes), 0) != -1 || errno != EACCES) _exit(6);
    proof->denied_reads++;
    void *mapping = mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, TARGET, 0);
    if (mapping != MAP_FAILED || errno != EACCES) _exit(7);
    proof->denied_maps++;
    mapping = mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, PERMITTED, 0);
    if (mapping == MAP_FAILED || memcmp(mapping, public_bytes, sizeof(public_bytes) - 1)) _exit(8);
    proof->permitted_maps++;
    munmap(mapping, 4096);
  }
  void *peer_result;
  if (pthread_join(peer, &peer_result) || peer_result != NULL) _exit(9);
  errno = 0;
  long escaped = syscall(SYS_clone, CLONE_UNTRACED | SIGCHLD, NULL, NULL, NULL, 0);
  if (escaped == 0) _exit(10);
  if (escaped != -1 || errno != EPERM) _exit(10);
  proof->untraced_refused = 1;
  if (syscall(SYS_clone3, NULL, 0) != -1 || errno != ENOSYS) _exit(11);
  proof->clone3_refused = 1;
  if (syscall(SYS_io_uring_setup, 0, NULL) != -1 || errno != ENOSYS) _exit(12);
  proof->async_refused = 1;
  for (int mode = 0; mode < 2; mode++) {
    pid_t child = mode ? vfork() : fork();
    if (child < 0) _exit(13);
    if (child == 0) { execl(executable, executable, "--leaf", NULL); _exit(14); }
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) _exit(15);
  }
  proof->workload_passed = true;
  _exit(0);
}

static int locate(struct task *tasks, int used, pid_t tid) {
  for (int i = 0; i < used; i++) if (tasks[i].tid == tid && tasks[i].live) return i;
  return -1;
}

static bool resume(struct task *task) {
  if (ptrace(PTRACE_SYSCALL, task->tid, NULL, (void *)(intptr_t)task->signal)) return false;
  task->parked = false;
  task->signal = 0;
  return true;
}

static int trace(const char *path, const char *permitted, const char *executable,
    bool death, int ready_output) {
  struct stat protected_identity;
  if (stat(path, &protected_identity)) return 1;
  int gate[2];
  if (pipe2(gate, O_CLOEXEC)) return 1;
  pid_t child = fork();
  if (child == 0) {
    close(gate[1]);
    close(ready_output);
    char value;
    if (read(gate[0], &value, 1) != 1) _exit(2);
    close(gate[0]);
    workload(path, permitted, executable, death);
  }
  close(gate[0]);
  if (child < 0) { close(gate[1]); return 1; }
  struct task tasks[MAX_TASKS] = {{ .tid = child, .live = true }};
  int used = 1, live = 1, active = -1, frozen_swaps = 0;
  bool running_admission = false, failure = false, freezing = false, death_announced = false;
  long options = PTRACE_O_EXITKILL | PTRACE_O_TRACESYSGOOD | PTRACE_O_TRACECLONE |
    PTRACE_O_TRACEFORK | PTRACE_O_TRACEVFORK | PTRACE_O_TRACEEXEC;
  if (ptrace(PTRACE_SEIZE, child, NULL, (void *)options) ||
      ptrace(PTRACE_INTERRUPT, child, NULL, NULL)) failure = true;
  if (!failure && write(gate[1], "G", 1) != 1) failure = true;
  close(gate[1]);
  int64_t deadline = now() + 12000;
  while (live && !failure && !stopped && now() < deadline) {
    int status;
    pid_t tid = waitpid(-1, &status, __WALL | WNOHANG);
    if (tid == 0) { struct timespec pause = { .tv_nsec = 100000 }; nanosleep(&pause, NULL); continue; }
    if (tid < 0) { if (errno == EINTR) continue; failure = true; break; }
    int index = locate(tasks, used, tid);
    if (index < 0) {
      /* A child's inherited stop can arrive before its parent's event. */
      struct user_regs_struct owned;
      if (used == MAX_TASKS || !WIFSTOPPED(status) || ptrace(PTRACE_GETREGS, tid, NULL, &owned)) {
        failure = true; break;
      }
      index = used++;
      tasks[index] = (struct task){ .tid = tid, .live = true };
      live++; proof->traced_tasks++;
    }
    struct task *task = &tasks[index];
    if (WIFEXITED(status) || WIFSIGNALED(status)) {
      if (!WIFEXITED(status) || WEXITSTATUS(status)) failure = true;
      task->live = false; live--; proof->joined_tasks++;
      continue;
    }
    if (!WIFSTOPPED(status)) { failure = true; break; }
    task->parked = true;
    unsigned event = (unsigned)status >> 16;
    int signal = WSTOPSIG(status);
    if (event == PTRACE_EVENT_CLONE || event == PTRACE_EVENT_FORK || event == PTRACE_EVENT_VFORK) {
      unsigned long created;
      if (ptrace(PTRACE_GETEVENTMSG, tid, NULL, &created)) { failure = true; break; }
      if (locate(tasks, used, (pid_t)created) < 0) {
        if (used == MAX_TASKS) { failure = true; break; }
        tasks[used++] = (struct task){ .tid = (pid_t)created, .live = true };
        live++; proof->traced_tasks++;
      }
      if (event == PTRACE_EVENT_CLONE) proof->clone_events++;
      if (event == PTRACE_EVENT_FORK) proof->fork_events++;
      if (event == PTRACE_EVENT_VFORK) proof->vfork_events++;
    } else if (event == PTRACE_EVENT_EXEC) {
      proof->exec_events++;
    } else if (event == PTRACE_EVENT_STOP) {
      /* A seized peer is now parked; do not inject the synthetic stop. */
    } else if (signal == (SIGTRAP | 0x80)) {
      struct ptrace_syscall_info information;
      if (ptrace(PTRACE_GET_SYSCALL_INFO, tid, sizeof(information), &information) < 0) { failure = true; break; }
      if (information.op == PTRACE_SYSCALL_INFO_ENTRY) {
        struct user_regs_struct registers;
        if (ptrace(PTRACE_GETREGS, tid, NULL, &registers)) { failure = true; break; }
        if ((registers.orig_rax == SYS_clone && (registers.rdi & CLONE_UNTRACED)) ||
            registers.orig_rax == SYS_clone3) {
          task->refused = registers.orig_rax == SYS_clone3 ? ENOSYS : EPERM;
          registers.orig_rax = (unsigned long)-1;
          if (ptrace(PTRACE_SETREGS, tid, NULL, &registers)) { failure = true; break; }
        }
        task->admission = registers.orig_rax == SYS_pread64 ||
          (registers.orig_rax == SYS_mmap && !(registers.r10 & MAP_ANONYMOUS));
      } else if (information.op == PTRACE_SYSCALL_INFO_EXIT) {
        if (task->refused) {
          struct user_regs_struct registers;
          if (ptrace(PTRACE_GETREGS, tid, NULL, &registers)) { failure = true; break; }
          registers.rax = (unsigned long)-task->refused;
          if (ptrace(PTRACE_SETREGS, tid, NULL, &registers)) { failure = true; break; }
          task->refused = 0;
        }
        if (index == active && running_admission) {
          if (atomic_load(&proof->swaps) != frozen_swaps) { failure = true; break; }
          proof->frozen_windows++;
          active = -1; freezing = false; running_admission = false;
        }
      }
    } else if (event || signal == SIGTRAP) {
      failure = true; break;
    } else {
      task->signal = signal;
    }

    if (!freezing) {
      for (int i = 0; i < used; i++) {
        if (tasks[i].live && tasks[i].parked && tasks[i].admission) {
          active = i; freezing = true; break;
        }
      }
      if (death && !death_announced && live >= 3 && atomic_load(&proof->ready)) freezing = true;
      if (freezing) {
        for (int i = 0; i < used; i++) if (tasks[i].live && !tasks[i].parked &&
            ptrace(PTRACE_INTERRUPT, tasks[i].tid, NULL, NULL) && errno != ESRCH) failure = true;
      }
    }
    if (failure) break;
    bool all_parked = true;
    for (int i = 0; i < used; i++) if (tasks[i].live && !tasks[i].parked) all_parked = false;
    if (freezing && !running_admission && all_parked) {
      if (death) {
        proof->ownership_ready = true;
        death_announced = true;
        if (write(ready_output, "R", 1) != 1) { failure = true; break; }
        for (;;) pause();
      }
      if (active < 0) { failure = true; break; }
      struct task *admitted = &tasks[active];
      struct user_regs_struct registers;
      if (ptrace(PTRACE_GETREGS, admitted->tid, NULL, &registers)) { failure = true; break; }
      unsigned long descriptor = registers.orig_rax == SYS_mmap ? registers.r8 : registers.rdi;
      char fd_path[96];
      snprintf(fd_path, sizeof(fd_path), "/proc/%ld/fd/%lu", (long)admitted->tid, descriptor);
      struct stat target;
      bool refuse = stat(fd_path, &target) != 0 ||
        (target.st_dev == protected_identity.st_dev && target.st_ino == protected_identity.st_ino);
      /* Linearization: every owned peer is stopped until this kernel use exits. */
      frozen_swaps = atomic_load(&proof->swaps);
      if (!refuse && registers.orig_rax == SYS_pread64 && descriptor == TARGET) {
        atomic_store(&proof->phase, frozen_swaps + 1);
        struct timespec window = { .tv_nsec = 1000000 };
        nanosleep(&window, NULL);
        if (atomic_load(&proof->swaps) != frozen_swaps) { failure = true; break; }
      }
      if (refuse) {
        admitted->refused = EACCES;
        registers.orig_rax = (unsigned long)-1;
        if (ptrace(PTRACE_SETREGS, admitted->tid, NULL, &registers)) { failure = true; break; }
      }
      admitted->admission = false;
      proof->admissions++;
      running_admission = true;
      if (!resume(admitted)) failure = true;
    } else if (!freezing) {
      for (int i = 0; i < used; i++) if (tasks[i].live && tasks[i].parked && !resume(&tasks[i])) failure = true;
    }
  }
  if (live) failure = true;
  for (int i = 0; i < used; i++) if (tasks[i].live) kill(tasks[i].tid, SIGKILL);
  while (live) {
    int status;
    pid_t tid = waitpid(-1, &status, __WALL);
    if (tid < 0) { if (errno == EINTR) continue; break; }
    int index = locate(tasks, used, tid);
    if (index >= 0 && (WIFEXITED(status) || WIFSIGNALED(status))) {
      tasks[index].live = false; live--; proof->joined_tasks++;
    }
  }
  return failure || live ? 1 : 0;
}

int main(int count, char **arguments) {
  if (count == 2 && strcmp(arguments[1], "--leaf") == 0) {
    char bytes[64];
    return pread(TARGET, bytes, sizeof(bytes), 0) == -1 && errno == EACCES ? 0 : 1;
  }
  struct sigaction action = { .sa_handler = stop };
  sigemptyset(&action.sa_mask);
  sigaction(SIGALRM, &action, NULL); sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL);
  alarm(30);
  if (prctl(PR_SET_CHILD_SUBREAPER, 1)) return 1;
  proof = mmap(NULL, sizeof(*proof), PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  if (proof == MAP_FAILED) return 1;
  char directory[] = "/tmp/octant-concurrent-admission-XXXXXX";
  if (!mkdtemp(directory)) return 1;
  struct stat owner;
  bool identity = lstat(directory, &owner) == 0;
  char path[256], permitted[256], executable[4096];
  snprintf(path, sizeof(path), "%s/protected", directory);
  snprintf(permitted, sizeof(permitted), "%s/permitted", directory);
  ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
  bool ready = identity && length > 0;
  if (length > 0) executable[length] = 0;
  int protected_file = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
  int permitted_file = open(permitted, O_WRONLY | O_CREAT | O_EXCL, 0600);
  ready = ready && protected_file >= 0 && permitted_file >= 0 &&
    write(protected_file, secret_bytes, sizeof(secret_bytes) - 1) == (ssize_t)sizeof(secret_bytes) - 1 &&
    write(permitted_file, public_bytes, sizeof(public_bytes) - 1) == (ssize_t)sizeof(public_bytes) - 1;
  if (protected_file >= 0) close(protected_file);
  if (permitted_file >= 0) close(permitted_file);
  int notifications[2];
  ready = ready && pipe2(notifications, O_CLOEXEC) == 0;
  if (ready) {
    pid_t tracer = fork();
    if (tracer == 0) { close(notifications[0]); _exit(trace(path, permitted, executable, false, notifications[1])); }
    int status;
    if (tracer > 0 && join_owner(tracer, &status))
      proof->normal_passed = WIFEXITED(status) && WEXITSTATUS(status) == 0;
    tracer = fork();
    if (tracer == 0) { close(notifications[0]); _exit(trace(path, permitted, executable, true, notifications[1])); }
    struct pollfd notification = { .fd = notifications[0], .events = POLLIN };
    char message = 0;
    bool announced = tracer > 0 && poll(&notification, 1, 12000) == 1 &&
      read(notifications[0], &message, 1) == 1 && message == 'R';
    if (tracer > 0) {
      kill(tracer, SIGKILL);
      bool joined = join_owner(tracer, &status);
      int killed = 0;
      int64_t deadline = now() + 3000;
      while (now() < deadline) {
        pid_t adopted = waitpid(-1, &status, WNOHANG);
        if (adopted > 0) { if (WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL) killed++; continue; }
        if (adopted < 0 && errno == ECHILD) break;
        struct timespec pause = { .tv_nsec = 1000000 }; nanosleep(&pause, NULL);
      }
      proof->death_passed = announced && joined && killed == 2;
    }
    close(notifications[0]); close(notifications[1]);
  }
  alarm(0);
  struct stat current;
  bool removed = identity && lstat(directory, &current) == 0 && current.st_dev == owner.st_dev &&
    current.st_ino == owner.st_ino && S_ISDIR(current.st_mode) &&
    unlink(path) == 0 && unlink(permitted) == 0 && rmdir(directory) == 0;
  bool passed = ready && proof->normal_passed && proof->death_passed && proof->workload_passed &&
    proof->reads == ROUNDS && proof->denied_reads == ROUNDS && proof->denied_maps == ROUNDS &&
    proof->permitted_maps == ROUNDS && proof->clone_events >= 2 && proof->fork_events >= 2 &&
    proof->vfork_events == 1 && proof->exec_events == 2 && proof->untraced_refused &&
    proof->clone3_refused && proof->async_refused && removed && !stopped;
  printf("{\"kind\":\"owned-concurrent-admission\",\"status\":\"%s\",\"productionReady\":false,"
    "\"allowedReads\":%d,\"deniedReads\":%d,\"deniedMappings\":%d,\"allowedMappings\":%d,"
    "\"swaps\":%d,\"admissions\":%d,\"frozenWindows\":%d,\"cloneEvents\":%d,"
    "\"forkEvents\":%d,\"vforkEvents\":%d,\"execEvents\":%d,\"untracedCloneRefused\":%s,"
    "\"clone3Refused\":%s,\"asyncRefused\":%s,\"normalPassed\":%s,\"ownerDeathPassed\":%s,"
    "\"fixtureRemoved\":%s}\n", passed ? "measured" : "blocked", proof->reads, proof->denied_reads,
    proof->denied_maps, proof->permitted_maps, atomic_load(&proof->swaps), proof->admissions,
    proof->frozen_windows, proof->clone_events, proof->fork_events, proof->vfork_events, proof->exec_events,
    proof->untraced_refused ? "true" : "false", proof->clone3_refused ? "true" : "false",
    proof->async_refused ? "true" : "false", proof->normal_passed ? "true" : "false",
    proof->death_passed ? "true" : "false", removed ? "true" : "false");
  munmap(proof, sizeof(*proof));
  return passed ? 0 : 1;
}
