import type {DesignState} from './runtime';
import {store,getResource} from './store';
import {EditorAiConversation,WORKFLOW_PANEL} from './EditorAiConversation';
import {WorkflowHistory} from './WorkflowHistory';
import {errorMessage} from './Login';
import {aiIdentity,requestAi} from './ai-client';
type Controller=DesignState & Record<string,any>;

export function WorkflowOverlay({controller}:{controller:DesignState}){
 return <><WorkflowHistory controller={controller}/><EditorAiConversation controller={controller} panel={WORKFLOW_PANEL}/></>;
}

/** Behavior only: the builder's existing AI panel drives the Valasys agent with workflow tools. */
export function installWorkflowAi(c:Controller,context:()=>{id:string|null;ready:boolean}){
 let disposed=false,active:ReturnType<typeof requestAi>|undefined;
 const owner=aiIdentity(),restoreId=new URLSearchParams(location.search).get('ai_chat');
 c.state={...c.state,aiMessages:[],aiChatId:restoreId || crypto.randomUUID(),pendingAiDraft:null};
 const assistantText=(m:any)=>{
  const r=m.result,flow=r?.operation==='workflow'?r:null;
  const lines=[flow?.message || m.text || m.error || (['queued','running'].includes(m.status)?'Working on your request...':'Unable to finish this request.')];
  if(flow){lines.push(...(flow.changes || []).map((x:string)=>`• ${x}`));if(flow.issues?.length)lines.push(`Before publishing: ${flow.issues.join(' ')}`);}
  return lines.join('\n');
 };
 async function refreshHistory(){
  const data=await getResource(`/account/ai/chats/${c.state.aiChatId}`,true);if(disposed || owner!==aiIdentity())return null;
  c.setState({aiMessages:data.messages.map((m:any)=>({id:m.id,role:m.role,text:m.role==='user'?m.text:assistantText(m)}))});
  return data;
 }
 // Only the persisted builder fields; transient layout keys (prefixed "_") stay in the browser.
 const documentOf=(w:any)=>({name:w.name,tkey:w.tkey,tcfg:w.tcfg || {},settings:w.settings,graph:{nodes:w.graph.nodes.map((n:any)=>Object.fromEntries(Object.entries(n).filter(([k])=>!k.startsWith('_')))),edges:w.graph.edges}});
 const snapshot=()=>JSON.stringify(documentOf(c.cur()));
 function apply(result:any){
  const d=result.document;
  c.change((w:any)=>({...w,name:d.name,tkey:d.tkey,tcfg:d.tcfg || {},trigger:c.tLabel(d.tkey),settings:{...w.settings,...d.settings},graph:c.tidy({graph:structuredClone(d.graph)}).graph}));
  c.setState({sel:null,selEdge:null,pendingAiDraft:null});setTimeout(()=>c.fit?.(),30);
 }
 async function follow(request:ReturnType<typeof requestAi>,before:string){
  active=request;c.setState({aiBusy:true});
  try{
   const row=await request.promise;if(disposed || owner!==aiIdentity())return;
   await refreshHistory();
   if(row.result?.operation!=='workflow')return;
   if(snapshot()!==before){c.setState({pendingAiDraft:row.result});return c.toast('The workflow changed while AI was working. Apply the saved draft to replace it, or ask again.');}
   apply(row.result);
   c.toast(row.result.issues?.length?'Workflow updated. Review the remaining issues before publishing.':'Workflow updated. Review it, run a test and publish when ready.',true);
  }catch(error){if(!disposed && owner===aiIdentity()){c.toast(errorMessage(error));await refreshHistory().catch(()=>undefined);}}
  finally{if(active===request){active=undefined;if(!disposed)c.setState({aiBusy:false});}}
 }
 c.aiBuild=()=>{
  const prompt=String(c.state.aiPrompt || '').trim();
  if(!prompt || active)return;
  if(!context().ready || !c.cur())return c.toast('Wait for the workflow to finish loading.');
  if(prompt.length>4000)return c.toast('Keep your message under 4,000 characters.');
  const id=context().id,before=snapshot();
  c.setState((s:any)=>({aiPrompt:'',aiMessages:[...s.aiMessages,{id:crypto.randomUUID(),role:'user',text:prompt}]}));
  const url=new URL(location.href);url.searchParams.set('ai_chat',c.state.aiChatId);history.replaceState({},'',url);
  void follow(requestAi({operation:'workflow',instruction:prompt},undefined,{chatId:c.state.aiChatId,settings:{workflow:{...(id && id!=='draft'?{id}:{}),document:JSON.parse(before)},timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}}),before);
 };
 c.applyAiDraft=()=>{if(c.state.pendingAiDraft && !active)apply(c.state.pendingAiDraft);};
 c.stopAiWriting=()=>void active?.cancel().catch((error:unknown)=>c.toast(errorMessage(error)));
 c.aiSubject=()=>c.toast('Workflow emails use the saved template subject. Ask Valasys AI to change the email, or edit the template.');
 if(restoreId)void (async()=>{
  try{const data=await refreshHistory();const pending=data?.messages.find((m:any)=>m.role==='assistant' && ['queued','running'].includes(m.status));
   if(pending && !active){const wait=()=>context().ready?void follow(requestAi({},undefined,{runId:pending.run_id}),snapshot()):setTimeout(wait,200);wait();}}
  catch(error){if(!disposed && (error as any)?.status!==404)c.toast(errorMessage(error));}
 })();
 const unsubscribe=store.subscribe(()=>{if(aiIdentity()!==owner){void active?.cancel().catch(()=>{});active=undefined;if(!disposed)c.setState({aiBusy:false,aiMessages:[],aiChatId:crypto.randomUUID(),pendingAiDraft:null});}});
 return ()=>{disposed=true;active?.detach();unsubscribe();};
}
