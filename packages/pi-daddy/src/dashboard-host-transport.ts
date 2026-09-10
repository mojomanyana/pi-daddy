import { createServer, createConnection, type Socket } from "node:net";
import { lstat, realpath, chmod } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { parseRetentionJson } from "./retention-json.ts";
import { isDashboardHost, dashboardHostRequest, type DashboardHost, type DashboardHostRequest } from "./dashboard-host.ts";
export const ENV_DASHBOARD_HOST_SOCKET="PI_DADDY_HOST_SOCKET";
export type DashboardConnection={frame:DashboardHost["frame"];action:DashboardHost["action"]};
const connections=new WeakSet<object>();
export const isDashboardConnection=(v:unknown):v is DashboardConnection=>isDashboardHost(v)||typeof v==="object"&&v!==null&&connections.has(v);
async function parent(path:string){if(!isAbsolute(path)||Buffer.byteLength(path)>100||await realpath(dirname(path))!==dirname(path))throw Error("canonical bounded private dashboard socket required");const s=await lstat(dirname(path));if(!s.isDirectory()||s.mode&0o077||s.uid!==process.getuid?.())throw Error("private owned dashboard socket parent required");}
/** Same original host process. No worker socket, native TUI attach, PID lookup or authority transport. */
export async function serveDashboardHost(path:string,host:DashboardHost){
  if(!isDashboardHost(host))throw Error("original dashboard host required");await parent(path);const clients=new Set<Socket>(),tasks=new Set<Promise<void>>();
  const server=createServer(socket=>{if(clients.size>=4){socket.destroy();return;}clients.add(socket);socket.on("close",()=>clients.delete(socket));socket.on("error",()=>{});socket.setTimeout(5000,()=>socket.destroy());let size=0,used=false;const chunks:Buffer[]=[];
    socket.on("data",bytes=>{if(used)return;size+=bytes.length;if(size>65536){socket.destroy();return;}chunks.push(bytes);if(bytes.at(-1)!==10)return;used=true;
      const task=(async()=>{try{const text=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));const r=parseRetentionJson(text,65536) as {operation:string;request?:DashboardHostRequest};let result:unknown;
        if(Object.keys(r).join()==="operation"&&r.operation==="frame")result=await host.frame();
        else if(Object.keys(r).sort().join()==="operation,request"&&r.operation==="action")result=await host.action(dashboardHostRequest(r.request!));else throw Error("closed dashboard protocol required");
        const output=JSON.stringify({ok:true,result})+"\n";if(Buffer.byteLength(output)>512*1024)throw Error("dashboard frame bound exceeded");socket.end(output);
      }catch{socket.end(JSON.stringify({ok:false,error:"refused or acknowledgement unknown; explicit readback only"})+"\n");}})();tasks.add(task);void task.finally(()=>tasks.delete(task));
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(path,()=>{server.off("error",reject);resolve();});});
  try{await chmod(path,0o600);}catch(error){server.close();throw error;}
  return Object.freeze({path,close:()=>new Promise<void>((resolve,reject)=>{for(const c of clients)c.destroy();server.close(e=>e?reject(e):void Promise.allSettled([...tasks]).then(()=>resolve()));})});
}
/** Explicit operator-selected endpoint. Socket ownership is access policy, not module/human authentication. */
export function connectDashboardHost(path:string):DashboardConnection{
  const call=async(operation:string,request?:DashboardHostRequest)=>{await parent(path);const s=await lstat(path);if(!s.isSocket()||s.mode&0o077||s.uid!==process.getuid?.())throw Error("private original dashboard endpoint unavailable");
    return new Promise<any>((resolve,reject)=>{const socket=createConnection(path);let size=0,done=false;const chunks:Buffer[]=[];const fail=(e:unknown)=>{if(!done){done=true;socket.destroy();reject(e);}};
      socket.setTimeout(5000,()=>fail(Error("dashboard acknowledgement timeout; do not repeat action")));socket.on("error",fail);socket.on("connect",()=>socket.write(JSON.stringify({operation,...(request?{request}:{})})+"\n"));
      socket.on("data",b=>{size+=b.length;if(size>512*1024){fail(Error("dashboard frame limit"));return;}chunks.push(b);});
      socket.on("end",()=>{try{const text=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));const r=parseRetentionJson(text,512*1024) as {ok:boolean;result:unknown};if(r.ok!==true)throw Error("dashboard refused or acknowledgement unknown");if(operation==="frame"&&(r.result as {version?:string})?.version!=="producer-dashboard-frame-v1")throw Error("incompatible dashboard host");if(!done){done=true;resolve(r.result);}}catch(e){fail(e);}});
      socket.on("close",()=>{if(!done)fail(Error("dashboard disconnected; acknowledgement unknown"));});
    });
  };
  const api={frame:()=>call("frame"),action:(r:DashboardHostRequest)=>call("action",dashboardHostRequest(r))};connections.add(api);return Object.freeze(api);
}
