/* Test-only same-PID gate: register real birth BEFORE native frontend can connect. No env mutation. */
#include <unistd.h>
extern char **environ;
int main(int argc,char **argv) {
    char go;
    if(argc!=4||read(3,&go,1)!=1||go!='G'||close(3))return 78;
    execve(argv[1],argv+1,environ);return 127;
}
