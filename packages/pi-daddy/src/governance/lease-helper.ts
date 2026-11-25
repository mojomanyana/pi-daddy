/**
 * Lock holder helper process and parent-side pipe helpers (Layer 1: governance).
 *
 * If the parent dies while holding a writer lease, stdin closes and the helper signals
 * the attached subprocess (SIGTERM -> +500ms SIGKILL -> +750ms exit) before releasing flock.
 */

export const LEASE_READY = "PI_DADDY_LEASE_READY";

export const HELPER_SOURCE = `
let clean=false, target=null, buffered="";
process.stdout.write(${JSON.stringify(`${LEASE_READY}:`)}+process.pid+"\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{buffered+=chunk;
for(;;){const i=buffered.indexOf("\\n");
if(i<0)break;
const line=buffered.slice(0,i);
buffered=buffered.slice(i+1);
try{const value=JSON.parse(line);
if(value.release)clean=true;
else if(value.process_pid)target={process_pid:value.process_pid};
}catch{}}});
process.stdin.on("end",()=>{if(clean||!target)return process.exit(0);
if(target.process_pid){try{process.kill(target.process_pid,"SIGTERM")}catch{return process.exit(0)}
setTimeout(()=>{try{process.kill(target.process_pid,"SIGKILL")}catch{}},500);
return setTimeout(()=>process.exit(0),750);
}process.exit(0);});
process.stdin.resume();`;

export const unrefStream = (stream: unknown): void => {
  (stream as { unref?: () => void } | null)?.unref?.();
};
