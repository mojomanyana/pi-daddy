export interface GrantsConnectedCommandContext {
 runHost:(target:string)=>Promise<string>;
 openDashboard:()=>Promise<{kind:"opened"|"reused";paneId:string;visibleBesideCaller:boolean}>;
 ui:{notify(message:string,level:"info"|"error"):void};
}
/** Host lifecycle and pane placement live together; neither belongs in the capability-report renderer. */
export async function handleConnectedCommand(sub:string|undefined,target:string|undefined,ctx:GrantsConnectedCommandContext):Promise<boolean>{
 if(sub==="host"){
  try{ctx.ui.notify(`grants: ${await ctx.runHost(target??"")}`,"info");}
  catch(error){ctx.ui.notify(`grants: host unavailable — ${error instanceof Error?error.message:String(error)}`,"error");}
  return true;
 }
 if(sub==="dashboard"){
  try{const opened=await ctx.openDashboard();ctx.ui.notify(`grants: dashboard ${opened.kind} in Herdr pane ${opened.paneId} without changing focus`+(opened.visibleBesideCaller?".":" (the existing pane is in another tab)."),"info");}
  catch(error){ctx.ui.notify(`grants: dashboard unavailable — ${error instanceof Error?error.message:String(error)}`,"error");}
  return true;
 }
 return false;
}
