/* Controlled execve environment image, not a Bash/Pi profile or eligibility claim. */
#include <stdio.h>
extern char **environ;
int main(void) {
    for (char **entry = environ; *entry; entry++)
        if (puts(*entry) == EOF) return 78;
    return fflush(stdout) ? 78 : 0;
}
