/* CP1: bounded OS-only Unix byte bridge. Node owns roles, authorization and execution policy.
 * No command execution here. SO_PEERPIDFD + host proc binds even ancestor-namespace peers.
 * Trusted stdin/stdout are private coordinator pipes; never attach them to a requester.
 */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <poll.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#define PEERS 32
#define CHUNK 4096
#define CONTROL 16384
struct peer { int fd, pidfd, verified; unsigned long id, pid; unsigned char out[CHUNK]; size_t count, sent; };
static struct peer peers[PEERS];
static int listener=-1, failed;
static unsigned long next_id;
static char control[CONTROL];
static size_t used;
static int fault(const char *why) { fprintf(stderr,"cache broker: %s\n",why); failed=1; return -1; }
static int number(const char *value,unsigned long *out) {
    if (!value || !*value) return -1;
    unsigned long n=0;
    for (;*value;value++) { if (*value<'0'||*value>'9'||n>(1000000000UL-(unsigned long)(*value-'0'))/10) return -1; n=n*10+(unsigned long)(*value-'0'); }
    if (!n) return -1;
    *out=n; return 0;
}
static int host_pid(int fd,unsigned long *pid) {
    char path[160],data[4096];
    snprintf(path,sizeof(path),"/run/pi-daddy-cache-host-proc/self/fdinfo/%d",fd);
    int info=open(path,O_RDONLY|O_CLOEXEC); if(info<0) return fault("peer fdinfo unavailable");
    ssize_t bytes=read(info,data,sizeof(data)-1); int saved=errno;
    if(close(info)!=0) return fault("peer fdinfo close failed");
    errno=saved;
    if(bytes<=0 || bytes==(ssize_t)sizeof(data)-1) return fault("peer fdinfo read unavailable");
    data[bytes]=0;
    char *line=strstr(data,"\nPid:\t"); if(!line) return fault("peer fdinfo incompatible"); line+=6;
    char *end=strchr(line,'\n'); if(!end) return fault("peer fdinfo unterminated"); *end=0;
    if(!strcmp(line,"-1")) { *pid=0; return 0; }
    return number(line,pid)==0?0:fault("peer fdinfo PID malformed");
}
static int live(struct peer *p) {
    struct pollfd check={.fd=p->pidfd,.events=POLLIN}; int n=poll(&check,1,0);
    if(n<0) return fault("peer liveness unavailable");
    if(n) return 0;
    unsigned long pid=0; if(host_pid(p->pidfd,&pid)) return -1; return pid==p->pid;
}
static void drop(struct peer *p) {
    unsigned long id=p->id;
    if(p->fd>=0 && close(p->fd)) fault("peer socket close failed");
    if(p->pidfd>=0 && close(p->pidfd)) fault("peer identity close failed");
    p->fd=-1;p->pidfd=-1;p->id=0;p->verified=0;p->count=0;p->sent=0;
    if(id) printf("CP1 CLOSED %lu\n",id);
}
static int accept_peer(void) {
    int fd=accept4(listener,NULL,NULL,SOCK_CLOEXEC|SOCK_NONBLOCK);
    if(fd<0) return errno==EAGAIN||errno==EWOULDBLOCK||errno==EINTR?0:fault("accept failed");
    struct peer *p=NULL;for(int i=0;i<PEERS;i++)if(peers[i].fd<0){p=&peers[i];break;}
    if(!p) { if(close(fd))return fault("excess peer close failed"); return 0; }
    int identity=-1;socklen_t size=sizeof(identity);
    if(getsockopt(fd,SOL_SOCKET,SO_PEERPIDFD,&identity,&size) || size!=sizeof(identity) || identity<0) {
        if(identity>=0)close(identity);
        close(fd);return fault("SO_PEERPIDFD unavailable");
    }
    unsigned long pid=0;if(host_pid(identity,&pid) || !pid){close(identity);close(fd);return pid? -1:0;}
    if(next_id>=1000000000UL){close(identity);close(fd);return fault("peer identity sequence exhausted");}
    *p=(struct peer){.fd=fd,.pidfd=identity,.id=++next_id,.pid=pid};
    printf("CP1 OPEN %lu %lu\n",p->id,p->pid);return 0;
}
static int nibble(char c) { return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:-1; }
static int command(char *line) {
    char *save=NULL,*version=strtok_r(line," ",&save),*verb=strtok_r(NULL," ",&save),*idstr=strtok_r(NULL," ",&save),*arg=strtok_r(NULL," ",&save);
    unsigned long id=0;
    if(!version || strcmp(version,"CP1") || !verb || number(idstr,&id) || strtok_r(NULL," ",&save)) return fault("protocol mismatch or malformed control");
    struct peer *p=NULL;for(int i=0;i<PEERS;i++)if(peers[i].id==id){p=&peers[i];break;}
    if(!strcmp(verb,"CLOSE")) { if(arg)return fault("CLOSE has argument");if(p)drop(p);return 0; }
    if(strcmp(verb,"VERIFY") && strcmp(verb,"SEND"))return fault("unknown control");
    if(!arg)return fault("missing control argument");
    if(!p)return 0; /* already-closed peer; cannot acquire authority or deliver bytes */
    if(!strcmp(verb,"VERIFY")) {
        unsigned long pid=0;if(number(arg,&pid))return fault("VERIFY PID malformed");
        int valid=live(p);if(valid<0)return -1;
        if(pid!=p->pid || !valid){drop(p);return 0;}
        p->verified=1;printf("CP1 VERIFIED %lu %lu\n",p->id,p->pid);return 0;
    }
    size_t length=strlen(arg);if(!p->verified || p->count || !length || length>CHUNK*2 || length%2)return fault("SEND unverified, busy or oversized");
    int valid=live(p);if(valid<0)return -1;if(!valid){drop(p);return 0;}
    for(size_t i=0;i<length;i+=2){int hi=nibble(arg[i]),lo=nibble(arg[i+1]);if(hi<0||lo<0)return fault("SEND bytes malformed");p->out[i/2]=(unsigned char)((hi<<4)|lo);}
    p->count=length/2;p->sent=0;return 0;
}
static int controls(void) {
    char bytes[4096];ssize_t count=read(STDIN_FILENO,bytes,sizeof(bytes));
    if(count==0)return 1;
    if(count<0)return errno==EINTR?0:fault("control read failed");
    for(ssize_t i=0;i<count;i++) {
        if(bytes[i]=='\n') {control[used]=0;if(command(control))return -1;used=0;}
        else {if(!bytes[i]||used>=sizeof(control)-1)return fault("control frame invalid or oversized");control[used++]=bytes[i];}
    }
    return 0;
}
static int transfer(struct peer *p,short events) {
    if(events&(POLLERR|POLLNVAL)){drop(p);return 0;}
    int valid=live(p);if(valid<0)return -1;if(!valid){drop(p);return 0;}
    if(events&POLLOUT) {
        ssize_t count=send(p->fd,p->out+p->sent,p->count-p->sent,MSG_NOSIGNAL);
        if(count>0){p->sent+=(size_t)count;if(p->sent==p->count){printf("CP1 SENT %lu %zu\n",p->id,p->count);p->count=0;p->sent=0;}}
        else if(count==0 || (errno!=EINTR&&errno!=EAGAIN&&errno!=EWOULDBLOCK)){drop(p);return 0;}
    }
    if(p->fd<0)return 0;
    if(events&POLLIN) {
        unsigned char bytes[CHUNK];ssize_t count=recv(p->fd,bytes,sizeof(bytes),0);
        if(count>0){printf("CP1 DATA %lu ",p->id);for(ssize_t i=0;i<count;i++)printf("%02x",bytes[i]);putchar('\n');}
        else if(count==0 || (errno!=EINTR&&errno!=EAGAIN&&errno!=EWOULDBLOCK)){drop(p);return 0;}
    } else if(events&POLLHUP)drop(p);
    return 0;
}
int main(int argc,char **argv) {
    for(int i=0;i<PEERS;i++){peers[i].fd=-1;peers[i].pidfd=-1;}
    if(argc!=2 || strlen(argv[1])>=sizeof(((struct sockaddr_un*)0)->sun_path) || argv[1][0]!='/')return 78;
    struct sockaddr_un address={.sun_family=AF_UNIX};strcpy(address.sun_path,argv[1]);
    listener=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0);
    if(listener<0 || bind(listener,(struct sockaddr*)&address,sizeof(address)) || listen(listener,PEERS)){fault("private listener unavailable; path never unlinked");goto out;}
    printf("CP1 READY\n");if(fflush(stdout)){fault("control output failed");goto out;}
    while(!failed) {
        struct pollfd ready[PEERS*2+2]={{.fd=STDIN_FILENO,.events=POLLIN},{.fd=listener,.events=POLLIN}};
        for(int i=0;i<PEERS;i++) {
            ready[i*2+2]=(struct pollfd){.fd=peers[i].fd,.events=(peers[i].verified?POLLIN:0)|(peers[i].count?POLLOUT:0)};
            ready[i*2+3]=(struct pollfd){.fd=peers[i].pidfd,.events=POLLIN};
        }
        int count=poll(ready,PEERS*2+2,-1);if(count<0){if(errno==EINTR)continue;fault("poll failed");break;}
        if(ready[0].revents&(POLLIN|POLLHUP)){int done=controls();if(done)break;}
        if(ready[0].revents&(POLLERR|POLLNVAL)){fault("control lost");break;}
        for(int i=0;i<PEERS&&!failed;i++)if(peers[i].fd>=0) {
            if(ready[i*2+3].revents)drop(&peers[i]);
            else if(ready[i*2+2].revents)transfer(&peers[i],ready[i*2+2].revents);
        }
        if(!failed && ready[1].revents&POLLIN)accept_peer();
        if(ready[1].revents&(POLLERR|POLLHUP|POLLNVAL))fault("listener lost");
        if(fflush(stdout)){fault("control output failed");break;}
    }
    if(used)fault("incomplete control frame");
out:
    for(int i=0;i<PEERS;i++)if(peers[i].fd>=0)drop(&peers[i]);
    if(listener>=0&&close(listener))fault("listener close failed");
    if(fflush(stdout))fault("control output failed");
    return failed?78:0;
}
