/* Qualification-only Linux OS leaf, not published, installed, enabled or a cache.
 * Exercise Pi's existing shellPath with its Linux argv [-c, command]. Same-PID exec
 * preserves cwd, environ, inherited descriptors and ordinary signal/process-group
 * behavior. No graph, eligibility, authorization, replay or tracing policy here.
 * Original shell is a trusted compile-time fixture selection, never a model argument.
 */
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#ifndef PI_DADDY_FORWARD_SHELL
#define PI_DADDY_FORWARD_SHELL "/bin/bash"
#endif
extern char **environ;

int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "-c") != 0) {
    fputs("cache shell forwarder: unsupported shell invocation\n", stderr);
    return 126;
  }
  argv[0] = PI_DADDY_FORWARD_SHELL;
  execve(PI_DADDY_FORWARD_SHELL, argv, environ);
  fprintf(stderr, "cache shell forwarder: original shell exec failed (errno %d)\n", errno);
  return 127;
}
