/* Trusted-development Linux worker owner. Built and packaged; never compiled at runtime.
 * Direct children stay waitable until this single-threaded helper reaps them, preventing PID reuse
 * between children-list observation and pidfd_open. Detached descendants are adopted by subreaper.
 * SIGKILL of this helper is explicitly NOT a successful settlement: no receipt can be written.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t requested_signal;
static void on_signal(int signo) { requested_signal = signo; }
static long long monotonic_ms(void) {
  struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static void quoted(FILE *out, const char *s) {
  fputc('"', out);
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { fputc('\\', out); fputc(c, out); }
    else if (c < 32) fprintf(out, "\\u%04x", c);
    else fputc(c, out);
  }
  fputc('"', out);
}
static int read_text(const char *path, char *out, size_t size) {
  int fd = open(path, O_RDONLY | O_CLOEXEC); if (fd < 0) return -1;
  ssize_t n = read(fd, out, size - 1); close(fd); if (n <= 0) return -1;
  out[n] = 0; out[strcspn(out, "\r\n")] = 0; return 0;
}
static int self_start(char *out, size_t size) {
  char data[4096]; if (read_text("/proc/self/stat", data, sizeof(data)) < 0) return -1;
  char *end = strrchr(data, ')'); if (!end) return -1;
  char *save = NULL, *part = strtok_r(end + 2, " ", &save);
  for (int field = 3; part; field++, part = strtok_r(NULL, " ", &save)) {
    if (field == 22) { snprintf(out, size, "%s", part); return 0; }
  }
  return -1;
}
struct identity {
  const char *execution, *nonce, *root, *hash, *directory;
  char boot[80], ns[80], start[40], ownership[PATH_MAX], receipt[PATH_MAX];
  struct stat workspace;
  pid_t worker;
};
static void identity_json(FILE *out, const struct identity *id) {
  fprintf(out, "{\"revision\":1,\"executionId\":"); quoted(out, id->execution);
  fprintf(out, ",\"nonce\":"); quoted(out, id->nonce);
  fprintf(out, ",\"root\":"); quoted(out, id->root);
  fprintf(out, ",\"rootDevice\":\"%llu\",\"rootInode\":\"%llu\"", (unsigned long long)id->workspace.st_dev, (unsigned long long)id->workspace.st_ino);
  fprintf(out, ",\"bootId\":"); quoted(out, id->boot);
  fprintf(out, ",\"pidNamespace\":"); quoted(out, id->ns);
  fprintf(out, ",\"helperPid\":%d,\"helperStartTicks\":", getpid()); quoted(out, id->start);
  fprintf(out, ",\"helperSha256\":"); quoted(out, id->hash);
  fprintf(out, ",\"workerPid\":%d,\"ownershipPath\":", id->worker); quoted(out, id->ownership);
  fprintf(out, ",\"receiptPath\":"); quoted(out, id->receipt); fprintf(out, "}");
}
static int durable(const struct identity *id, int settled, int worker_status, const char *reason) {
  const char *path = settled ? id->receipt : id->ownership;
  char temp[PATH_MAX]; if (snprintf(temp, sizeof(temp), "%s.tmp", path) >= (int)sizeof(temp)) return -1;
  int fd = open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600); if (fd < 0) return -1;
  FILE *out = fdopen(fd, "w"); if (!out) { close(fd); return -1; }
  fprintf(out, "{\"state\":\"%s\",\"identity\":", settled ? "settled" : "ready"); identity_json(out, id);
  if (settled) {
    fprintf(out, ",\"workerCode\":"); if (WIFEXITED(worker_status)) fprintf(out, "%d", WEXITSTATUS(worker_status)); else fprintf(out, "null");
    fprintf(out, ",\"workerSignal\":%d,\"reason\":", WIFSIGNALED(worker_status) ? WTERMSIG(worker_status) : 0); quoted(out, reason);
    fprintf(out, ",\"reapedAll\":true");
  }
  fprintf(out, "}\n");
  int ok = fflush(out) == 0 && fsync(fd) == 0;
  if (fclose(out) != 0) ok = 0;
  if (!ok || link(temp, path) < 0 || unlink(temp) < 0) return -1;
  int dir = open(id->directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (dir < 0) return -1;
  ok = fsync(dir) == 0; close(dir); return ok ? 0 : -1;
}
static int milliseconds(const char *text, long maximum, long *value) {
  if (!*text) return -1;
  for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') return -1;
  char *end; errno = 0; long parsed = strtol(text, &end, 10);
  if (errno || *end || parsed < 0 || parsed > maximum) return -1;
  *value = parsed; return 0;
}
static int validate_channel(int fd, int writing) {
  struct stat info; int flags = fcntl(fd, F_GETFL);
  if (flags < 0 || fstat(fd, &info) < 0 || (!S_ISFIFO(info.st_mode) && !S_ISSOCK(info.st_mode))) return -1;
  if ((writing && (flags & O_ACCMODE) == O_RDONLY) || (!writing && (flags & O_ACCMODE) == O_WRONLY)) return -1;
  return writing ? 0 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
/* A direct child cannot reuse its PID before our waitpid. Forget its signal record only after reaping. */
struct signalled_child { pid_t pid; int signo; };
static struct signalled_child *signalled;
static size_t signalled_count;
static void forget_child(pid_t pid) {
  for (size_t i = 0; i < signalled_count; i++) if (signalled[i].pid == pid) {
    signalled[i] = signalled[--signalled_count]; return;
  }
}
/* Signal only this helper's direct children. No process-name, cwd, PID-group or global enumeration. */
static int signal_children(int signo) {
  char path[100]; snprintf(path, sizeof(path), "/proc/self/task/%d/children", getpid());
  FILE *children = fopen(path, "r"); if (!children) return -1;
  int pid, ok = 0, scanned;
  while ((scanned = fscanf(children, "%d", &pid)) == 1) {
    if (pid <= 0) { ok = -1; break; }
    size_t index = 0;
    while (index < signalled_count && signalled[index].pid != pid) index++;
    if (signo && index < signalled_count && signalled[index].signo == signo) continue;
    int pfd = (int)syscall(SYS_pidfd_open, pid, 0);
    if (pfd < 0) { if (errno != ESRCH) ok = -1; continue; }
    if (syscall(SYS_pidfd_send_signal, pfd, signo, NULL, 0) < 0 && errno != ESRCH) ok = -1;
    close(pfd);
    if (signo && ok == 0) {
      if (index == signalled_count) {
        void *next = realloc(signalled, (signalled_count + 1) * sizeof(*signalled));
        if (!next) { ok = -1; break; }
        signalled = next; signalled_count++; signalled[index].pid = pid;
      }
      signalled[index].signo = signo;
    }
  }
  if (scanned != EOF || ferror(children)) ok = -1;
  fclose(children); return ok;
}
int main(int argc, char **argv) {
  /* execution nonce canonical-root helper-sha ownership-dir grace-ms cleanup-ms -- command args */
  if (argc < 10 || strcmp(argv[8], "--")) return 64;
  struct identity id = { .execution=argv[1], .nonce=argv[2], .root=argv[3], .hash=argv[4], .directory=argv[5] };
  long grace, ceiling;
  if (milliseconds(argv[6], 60000, &grace) < 0 || milliseconds(argv[7], 120000, &ceiling) < 0 || ceiling < grace) return 64;
  if (validate_channel(3, 0) < 0 || validate_channel(4, 1) < 0) return 65;
  if (stat(id.root, &id.workspace) < 0 || !S_ISDIR(id.workspace.st_mode)) return 65;
  if (read_text("/proc/sys/kernel/random/boot_id", id.boot, sizeof(id.boot)) < 0 || self_start(id.start, sizeof(id.start)) < 0) return 65;
  ssize_t n = readlink("/proc/self/ns/pid", id.ns, sizeof(id.ns)-1); if (n < 0) return 65; id.ns[n] = 0;
  if (snprintf(id.ownership, sizeof(id.ownership), "%s/ownership.json", id.directory) >= (int)sizeof(id.ownership) ||
      snprintf(id.receipt, sizeof(id.receipt), "%s/receipt.json", id.directory) >= (int)sizeof(id.receipt)) return 65;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) return 65;
  int probe = (int)syscall(SYS_pidfd_open, getpid(), 0); if (probe < 0) return 65; close(probe);
  if (signal_children(0) < 0) return 65; /* Probe /proc children support before admitting work. */
  signal(SIGPIPE, SIG_IGN); signal(SIGTERM, on_signal); signal(SIGINT, on_signal); signal(SIGHUP, on_signal);
  int gate[2]; if (pipe2(gate, O_CLOEXEC) < 0) return 65;
  id.worker = fork(); if (id.worker < 0) return 65;
  if (id.worker == 0) {
    close(gate[1]); close(3); close(4); close(5);
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    char release; if (read(gate[0], &release, 1) != 1 || release != 'S') _exit(125);
    close(gate[0]); if (chdir(id.root) < 0) _exit(126);
    execvp(argv[9], &argv[9]); _exit(errno == ENOENT ? 127 : 126);
  }
  close(gate[0]);
  int ready = durable(&id, 0, 0, "ready") == 0;
  if (ready) {
    FILE *status = fdopen(dup(4), "w");
    if (status) { identity_json(status, &id); fputc('\n', status); if (ferror(status)) ready = 0; if (fclose(status) != 0) ready = 0; }
    else ready = 0;
  }
  long long stopping = ready ? 0 : monotonic_ms();
  const char *reason = ready ? "worker-exit" : "ownership-write-failed";
  int started = 0, worker_status = 0, worker_reaped = 0, control_open = 1;
  for (;;) {
    int status; pid_t reaped;
    while ((reaped = waitpid(-1, &status, WNOHANG)) > 0) {
      forget_child(reaped);
      if (reaped == id.worker) { worker_status=status; worker_reaped=1; if (!stopping) stopping=monotonic_ms(); }
    }
    if (reaped < 0 && errno == ECHILD) {
      if (!worker_reaped) return 74;
      if (durable(&id, 1, worker_status, reason) < 0) return 74;
      close(gate[1]); return 0;
    }
    if (requested_signal && !stopping) { stopping=monotonic_ms(); reason="helper-signal"; }
    char control[32]; ssize_t received = control_open ? read(3, control, sizeof(control)) : -1;
    if (control_open && (received == 0 || (received < 0 && errno != EAGAIN && errno != EWOULDBLOCK))) { control_open=0; if (!stopping) { stopping=monotonic_ms(); reason="owner-loss"; } }
    if (received > 0) for (ssize_t i=0;i<received;i++) {
      if (control[i] == 'K') {
        if (!stopping) { stopping=monotonic_ms(); reason="cancelled"; }
        long long immediate = monotonic_ms()-grace;
        if (stopping > immediate) stopping=immediate; /* Escalate without rewriting the original cause. */
      }
      if (control[i] == 'C' && !stopping) { stopping=monotonic_ms(); reason="cancelled"; }
      if (control[i] == 'S' && ready && !started && !stopping) { started=1; if (write(gate[1], "S", 1) != 1) { stopping=monotonic_ms(); reason="start-failed"; } }
    }
    if (stopping) {
      long long elapsed = monotonic_ms()-stopping;
      if (signal_children(elapsed >= grace ? SIGKILL : SIGTERM) < 0) return 74;
      if (elapsed >= ceiling) return 74; /* Missing receipt preserves uncertainty. */
    }
    struct pollfd pfd = { .fd=control_open ? 3 : -1, .events=POLLIN | POLLHUP };
    int polled = poll(&pfd, 1, 10);
    if ((polled < 0 && errno != EINTR) || (polled > 0 && (pfd.revents & POLLNVAL))) {
      control_open=0;
      if (!stopping) { stopping=monotonic_ms(); reason="owner-loss"; }
    }
  }
}
