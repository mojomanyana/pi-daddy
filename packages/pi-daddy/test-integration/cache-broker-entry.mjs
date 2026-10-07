import { spawn } from 'node:child_process';
export async function startCacheProcess(args) {
 const child=spawn(args[0],[args[1]],{stdio:['pipe','pipe','pipe']});
 child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);process.stdin.pipe(child.stdin);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>code===0?resolve():reject(Error(`cache broker exit ${code}/${signal}`)));});
 done.then(()=>process.exit(0),error=>{process.stderr.write(String(error)+'\n');process.exit(78)});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});
}
