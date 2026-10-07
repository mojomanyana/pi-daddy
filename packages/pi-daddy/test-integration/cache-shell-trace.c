/* Qualification-only OS launch leaf. Not shipped/installed or a cache implementation.
 * Compile-time fixture config chooses a private tracer/receipt destination. Node owns
 * all eligibility/state decisions; this leaf only preserves the shell argv and env.
 * Tracer -D preserves the target's parent relationship; -ff observes descendants.
 * Raw environment tracing is allowed ONLY for this synthetic fixture environment.
 */
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include TRACE_CONFIG
extern char **environ;
#ifndef TRACE_KILL_ON_EXIT
#define TRACE_KILL_ON_EXIT 1
#endif

int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "-c") != 0) {
    fputs("cache trace fixture: unsupported shell invocation\n", stderr);
    return 126;
  }
  char *arguments[] = {
    "/lib64/ld-linux-x86-64.so.2", "--library-path", TRACE_LIBRARIES,
    TRACE_PROGRAM,
#if TRACE_DAEMON
    "-D",
#endif
#if TRACE_KILL_ON_EXIT
    "--kill-on-exit",
#endif
    "--interruptible=1",
#if TRACE_FOLLOW
    "-ff",
#endif
    "-q", "-yy", "-v", "-s", "4096", "-o", TRACE_OUTPUT,
    "--", "/bin/bash", "-c", argv[2], NULL
  };
  execve(arguments[0], arguments, environ);
  fprintf(stderr, "cache trace fixture: tracer exec failed (errno %d)\n", errno);
  return 127;
}
