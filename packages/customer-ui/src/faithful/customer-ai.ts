import type {DesignState} from './runtime';
import {store,getResource} from './store';
import {aiIdentity,requestAi} from './ai-client';
import {errorMessage} from './Login';

/** Connect the existing drawer view to owner-scoped durable conversations. */
export function installCustomerAi(base:DesignState){
 const c=base as DesignState & Record<string,any>,owner=aiIdentity();
 const identity=store.getState().session.identity;
 const key=`valasys.ai.drawer:${identity?.user.id}:${identity?.current_customer_id}`;
 const originalVals=c.aiVals.bind(c),setState=c.setState.bind(c);
 let disposed=false,active:ReturnType<typeof requestAi>|undefined,cid:string|undefined,epoch=0,restored=false;
 const alive=()=>!disposed && aiIdentity()===owner;
 const remember=(id?:string)=>{try{if(id)sessionStorage.setItem(key,id);else sessionStorage.removeItem(key);}catch{/* Storage may be disabled. */}};
 const saved=()=>{try{return sessionStorage.getItem(key);}catch{return null;}};
 const steps=(rows:any[]=[])=>rows.map(s=>`${s.name.replace(/_/g,' ')}: ${s.status}`);
 function message(m:any,rows:any[]=[]){
  const draft=m.result?.operation==='draft'?m.result:null;
  return {id:m.id,role:m.role==='user'?'user':'ai',status:['queued','running'].includes(m.status)?'working':'done',
   text:draft?[draft.message,...(Array.isArray(draft.changes)?draft.changes.map((x:string)=>`• ${x}`):[]),`Subject: ${draft.subject}`,draft.changes?.length?'':draft.text].filter(Boolean).join('\n\n'):m.text || m.error || (m.status==='cancelled'?'Generation stopped.':''),
   steps:steps(rows.filter(s=>s.run_id===m.run_id)),acts:draft?[{k:0,type:'go',state:'open',label:'Review email draft',desc:'Open this conversation to approve and save the draft.',btn:'Review',run:()=>location.assign(`/ai-agent?chat=${cid}`)}]:[],
   ms:m.run_created_at && m.run_updated_at?Math.max(0,new Date(m.run_updated_at).getTime()-new Date(m.run_created_at).getTime()):0};
 }
 async function load(id:string,n:number){
  const data=await getResource(`/account/ai/chats/${id}`,true);
  if(!alive() || n!==epoch)return;
  cid=id;remember(id);c.setState({aiMsgs:data.messages.map((m:any)=>message(m,data.steps)),aiBusy:false},c.aiScroll);
  return data;
 }
 async function follow(id:string,request:ReturnType<typeof requestAi>,n:number){
  active=request;c.setState({aiBusy:true});
  try{await request.promise;if(alive() && n===epoch)await load(id,n);}
  catch(error){if(alive() && n===epoch){
   c.toast(errorMessage(error));
   await load(id,n).catch(()=>{if(alive() && n===epoch)c.setState((s:any)=>({aiMsgs:s.aiMsgs.map((m:any)=>m.status==='working'?{...m,status:'done',text:errorMessage(error)}:m)}));});
  }}finally{if(active===request)active=undefined;if(alive() && n===epoch)c.setState({aiBusy:false});}
 }
 async function restore(){
  if(restored || !alive())return;restored=true;const id=saved();if(!id)return;
  const n=++epoch;c.setState({aiBusy:true});
  try{const data=await load(id,n);const pending=data?.messages.find((m:any)=>m.role==='assistant' && ['queued','running'].includes(m.status));
   if(pending)void follow(id,requestAi({},undefined,{runId:pending.run_id}),n);
  }catch(error){if(alive() && n===epoch){remember();c.setState({aiBusy:false});c.toast(errorMessage(error));}}
 }
 c.setState=(update:any,callback?:()=>void)=>{const open=c.state.aiOpen;setState(update,callback);if(!open && c.state.aiOpen)void restore();};
 c.aiAsk=(raw:string)=>{
  const q=raw?.trim();if(!alive() || !q || c.state.aiBusy || active)return;
  if(q.length>4000)return c.toast('Keep your message under 4,000 characters.');
  const id=cid || crypto.randomUUID(),n=++epoch,mid=crypto.randomUUID();cid=id;restored=true;
  c.setState((s:any)=>({aiInput:'',aiLastQ:q,aiBusy:true,aiMsgs:[...s.aiMsgs,{role:'user',text:q},{id:mid,role:'ai',status:'working',steps:[],acts:[],t0:Date.now()}]}),c.aiScroll);
  void follow(id,requestAi({operation:'assist',instruction:q},(_status,run)=>{
   if(alive() && n===epoch)c.setState((s:any)=>({aiMsgs:s.aiMsgs.map((m:any)=>m.id===mid?{...m,steps:steps(run?.steps)}:m)}),c.aiScroll);
  },{chatId:id,settings:{timezone:Intl.DateTimeFormat().resolvedOptions().timeZone},onAccepted:()=>{if(alive() && n===epoch)remember(id);}}),n);
 };
 c.aiVals=(view:string)=>{
  const v=originalVals(view);
  v.aiClear=()=>{++epoch;active?.detach();active=undefined;cid=undefined;restored=true;remember();c.setState({aiMsgs:[],aiBusy:false,aiInput:'',aiLastQ:null});};
  v.aiFullHref=cid?`/ai-agent?chat=${encodeURIComponent(cid)}`:'/ai-agent';
  v.aiFootNote='Chat history is saved. Review proposed drafts before applying.';
  return v;
 };
 const unsubscribe=store.subscribe(()=>{if(!alive()){++epoch;active?.detach();active=undefined;if(!disposed)c.setState({aiMsgs:[],aiBusy:false,aiInput:''});}});
 return {dispose:()=>{disposed=true;++epoch;active?.detach();unsubscribe();}};
}
