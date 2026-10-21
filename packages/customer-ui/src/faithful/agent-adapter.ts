import type {DesignState} from './runtime';
import {store,getResource,performAction} from './store';
import {errorMessage} from './Login';
import {aiIdentity,requestAi} from './ai-client';
type Controller=DesignState & Record<string,any>;
/** Original reference view, backed by owner-scoped durable conversations. */
export function prepareAgent(base:DesignState){
 const c=base as Controller,originalVals=c.renderVals.bind(c);
 let disposed=false,active:ReturnType<typeof requestAi>|undefined,target:string|undefined,sequence=0,loading=0,stopping=false,olderLoading=false;
 const saving=new Set<string>();
 const owner=aiIdentity(),session=store.getState().session;
 const org=session.identity?.memberships.find(m=>m.customer_id===session.identity?.current_customer_id)?.org_name || 'Your workspace';
 c.props.textOverrides={'Acme workspace \u00b7':org+' \u00b7 '};
 const emptyMem=()=>({ind:'',about:'',voice:'',audience:'',rules:'',learned:[]});
 c.state={...c.state,contextGroups:[],chats:[],activity:[],routines:[],skills:[],mem:emptyMem()};
 const alive=()=>!disposed && owner===aiIdentity();
 const url=(id:string)=>{const u=new URL(location.href);u.searchParams.set('chat',id);u.searchParams.delete('q');history.replaceState({},'',u);};
 const step=(s:any)=>({label:({read_plan:'Planning workspace reads',context_evidence:'Prepared workspace evidence',workspace_overview:'Read workspace overview',list_campaigns:'Read campaigns',read_campaign:'Read campaign details',list_templates:'Read templates',read_template:'Read template content',list_workflows:'Read workflows',read_workflow:'Read workflow details',read_audience:'Read audience details',list_audiences:'Read audiences',delivery_summary:'Read delivery totals',domain_status:'Read domain verification',search_history:'Searched earlier chats',read_history:'Read an earlier message',read_workspace:'Read workspace data',view_email:'Reviewed the email',read_element:'Inspected an email section',write_email:'Designed the email',update_element:'Edited the email',insert_html:'Added to the email',replace_element:'Rewrote an email section',remove_element:'Removed an email section',set_subject:'Set subject and preview text',view_workflow:'Reviewed the workflow',build_workflow:'Built the workflow',add_steps:'Added workflow steps',update_step:'Edited a workflow step',remove_step:'Removed a workflow step',set_trigger:'Set the workflow trigger',update_workflow_settings:'Updated workflow settings'} as any)[s.name] || 'Checked context',meta:s.status==='completed'?'':s.status});
 function message(m:any,steps:any[]=[]){
  if(m.role==='user')return {id:m.id,role:'user',text:m.text,ctx:[]};
  const pending=['queued','running'].includes(m.status),draft=m.result?.operation==='draft'?m.result:null,flow=m.result?.operation==='workflow'?m.result:null;
  const text=flow?[flow.message,...(flow.changes || []).map((x:string)=>`• ${x}`),...(flow.issues?.length?[`Before publishing: ${flow.issues.join(' ')}`]:[])]:draft?[...(draft.message?[draft.message]:[]),...(Array.isArray(draft.changes)?draft.changes.map((x:string)=>`• ${x}`):[]),`Subject: ${draft.subject}`,...(draft.changes?.length?[]:[draft.text])]:[m.text || m.error || (m.status==='cancelled'?'Generation stopped.':'AI could not finish this response.')];
  return {id:m.id,run_id:m.run_id,role:'agent',status:pending?'working':'done',outcome:m.status,t0:new Date(m.created_at).getTime(),ms:m.run_created_at && m.run_updated_at?Math.max(0,new Date(m.run_updated_at).getTime()-new Date(m.run_created_at).getTime()):0,
   text:pending?[]:text,steps:steps.length?steps.map(step):[{label:pending?'Request queued':'Response saved',meta:''}],
   plan:flow?{title:'Save workflow draft',items:[{id:m.id,kind:'Build workflow draft',title:flow.name,detail:'Saved as an inactive draft. Review, test and publish it in the workflow builder.',status:m.decision || 'pending',link:m.workflow_id?`/workflow-builder?id=${encodeURIComponent(m.workflow_id)}`:undefined}]}:draft?{title:'Save email draft',items:[{id:m.id,kind:'Write email draft',title:draft.subject,detail:'Save as a template, then review in the editor.',status:m.decision || 'pending',link:m.template_id?`/email-builder?id=${encodeURIComponent(m.template_id)}`:undefined}]}:null};
 }
 async function loadChat(id:string,select=true,before?:number){
  const n=select?++loading:loading,data=await getResource(`/account/ai/chats/${id}${before?`?before_seq=${before}`:''}`,true);if(!alive() || (select && n!==loading))return;
  const chat={id:data.chat.id,title:data.chat.title,at:new Date(data.chat.updated_at).getTime(),msgs:before?[...data.messages.map((m:any)=>message(m,(data.steps || []).filter((s:any)=>s.run_id===m.run_id))),...(c.state.chats.find((x:any)=>x.id===id)?.msgs || [])]:data.messages.map((m:any)=>message(m,(data.steps || []).filter((s:any)=>s.run_id===m.run_id))),hasMore:data.has_more,beforeSeq:data.before_seq};
  c.setState((s:any)=>({chats:s.chats.some((x:any)=>x.id===id)?s.chats.map((x:any)=>x.id===id?chat:x):[chat,...s.chats],...(select?{chatId:id,section:'chat',mem:(data.chat.settings as any)?.mem || emptyMem(),skills:(data.chat.settings as any)?.skills || [],mode:(data.chat.settings as any)?.mode || 'ask'}:{})}));
  if(select){url(id);const pending=data.messages.find((m:any)=>m.role==='assistant' && ['queued','running'].includes(m.status));if(pending && !active)void follow(id,requestAi({},undefined,{runId:pending.run_id}),false);}
  return chat;
 }
 async function follow(cid:string,request:ReturnType<typeof requestAi>,auto:boolean){
  const n=++sequence;active=request;target=cid;c.setState({busy:true});
  try{await request.promise;if(!alive() || n!==sequence)return;const chat=await loadChat(cid,false);if(auto && c.state.mode==='auto'){const item=chat?.msgs.at(-1)?.plan?.items[0];if(item)await c.setItem(cid,chat!.msgs.at(-1).id,item.id,'applied');}}
  catch(error){if(alive() && n===sequence){c.toast(errorMessage(error));await loadChat(cid,false).catch(()=>{c.setState((s:any)=>({chats:s.chats.map((chat:any)=>chat.id===cid?{...chat,msgs:chat.msgs.map((m:any)=>m.status==='working'?{...m,status:'done',outcome:'failed',text:[errorMessage(error)],steps:[]}:m)}:chat)}));});}}
  finally{if(active===request && !stopping){active=undefined;target=undefined;if(alive())c.setState({busy:false});}}
 }
 c.componentDidMount=()=>void(async()=>{
  try{const [data,catalog]=await Promise.all([getResource('/account/ai/chats',true),getResource('/account/ai/context',true).catch(()=>({groups:[]}))]);if(alive())c.setState({contextGroups:catalog.groups});if(!alive())return;
   c.setState((s:any)=>({chats:[...s.chats,...data.chats.filter((x:any)=>!s.chats.some((old:any)=>old.id===x.id)).map((x:any)=>({id:x.id,title:x.title,at:new Date(x.updated_at).getTime(),msgs:[]}))]}));
   if(active || c.state.chatId)return;
   const params=new URLSearchParams(location.search),q=params.get('q'),id=params.get('chat') || data.chats[0]?.id;
   if(q){c.setState({chatId:null});void c.ask(q);}else if(id)await loadChat(id);
  }catch(error){if(alive())c.toast(errorMessage(error));}
 })();
 c.componentDidUpdate=()=>{const el=c.scrollRef.current;if(!el)return;
  el.onscroll=()=>{c._stick=el.scrollHeight-el.scrollTop-el.clientHeight<40;const chat=c.curChat();if(el.scrollTop<24 && chat?.hasMore && !olderLoading){olderLoading=true;c._stick=false;const height=el.scrollHeight;void loadChat(chat.id,false,chat.beforeSeq).then(()=>requestAnimationFrame(()=>{el.scrollTop=el.scrollHeight-height;})).catch(error=>{if(alive())c.toast(errorMessage(error));}).finally(()=>{olderLoading=false;});}};
  if(c._stick!==false)el.scrollTop=el.scrollHeight;
 };
 c.newChat=()=>{++loading;c.setState({section:'chat',chatId:null,input:'',ctx:[]});const u=new URL(location.href);u.searchParams.delete('chat');u.searchParams.delete('q');history.replaceState({},'',u);c.inputRef.current?.focus();};
 c.ask=async(raw:string)=>{
  const q=raw?.trim();if(!q || active || c.state.busy)return;
  if(q.length>4000)return c.toast('Keep your message under 4,000 characters.');
  let cid=c.state.chatId,chats=c.state.chats;if(!cid){cid=crypto.randomUUID();chats=[{id:cid,title:q.slice(0,48),at:Date.now(),msgs:[]},...chats];}
  const selected=c.state.ctx.map((x:any)=>({kind:x.kind,id:x.id,label:x.label}));
  const um={id:crypto.randomUUID(),role:'user',text:q,ctx:[]},am={id:crypto.randomUUID(),role:'agent',steps:[{label:'Request queued',meta:''}],text:[],status:'working',t0:Date.now()};
  c.setState({chats:chats.map((chat:any)=>chat.id===cid?{...chat,msgs:[...chat.msgs,um,am],at:Date.now()}:chat),chatId:cid,input:'',ctx:[],atOpen:false,section:'chat',busy:true});url(cid);
  // The model decides whether to answer, clarify or propose a draft from canonical history.
  const auto=c.state.mode==='auto';
  const request=requestAi({operation:'assist',instruction:q},(status,run)=>{if(alive())c.patchMsg(cid,am.id,(m:any)=>({...m,steps:[...(run?.steps || []).map(step),{label:status==='running'?'Writing response':'Request queued',meta:''}]}));},{chatId:cid,settings:{mem:c.state.mem,skills:c.state.skills,mode:c.state.mode,context:selected,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone},onAccepted:row=>{if(alive())c.patchMsg(cid,am.id,(m:any)=>({...m,run_id:row.id}));}});
  await follow(cid,request,auto);
 };
 c.setItem=async(cid:string,_mid:string,id:string,decision:string)=>{
  if(saving.has(id))return;saving.add(id);
  try{await performAction(`/account/ai/chats/${cid}/messages/${id}/decision`,{decision});if(alive()){await loadChat(cid,false);c.toast(decision==='applied'?'Draft saved. Open it to review.':'Skipped');}}
  catch(error){if(alive())c.toast(errorMessage(error));}finally{saving.delete(id);}
 };
 c.runRoutine=()=>c.toast('Scheduled AI routines are not available yet.');
 c.undo=()=>c.toast('Open the saved template to edit or delete it.');
 c.renderVals=()=>{
  const v=originalVals();v.industryLabel=c.IND[c.state.mem.ind] || 'Industry not set';
  v.stop=()=>{if(stopping || !active)return;stopping=true;++sequence;const request=active,cid=target;void(async()=>{try{await request.cancel();if(alive() && cid)await loadChat(cid,false);}catch(error){if(alive())c.toast(errorMessage(error));}finally{stopping=false;if(active===request){active=undefined;target=undefined;}if(alive())c.setState({busy:false});}})();};
  v.recent=v.recent.map((item:any,i:number)=>{const id=c.state.chats[i].id;return {...item,onClick:()=>void loadChat(id).catch(error=>{if(alive())c.toast(errorMessage(error));}),
   onDelete:(event:Event)=>{event.stopPropagation();if(target===id)return c.toast('Stop the running reply before deleting this chat.');if(!window.confirm('Delete this chat? Its messages are removed permanently.'))return;
    void performAction(`/account/ai/chats/${encodeURIComponent(id)}`,undefined,'DELETE').then(()=>{if(!alive())return;c.setState((s:any)=>({chats:s.chats.filter((x:any)=>x.id!==id)}));if(c.state.chatId===id)c.newChat();c.toast('Chat deleted');})
     .catch(error=>{if(!alive())return;if(error?.status===404){c.setState((s:any)=>({chats:s.chats.filter((x:any)=>x.id!==id)}));if(c.state.chatId===id)c.newChat();}else c.toast(errorMessage(error));});}};});
  v.atGroups=(c.state.contextGroups || []).map((group:any)=>({name:group.name,items:group.items.map((item:any)=>({label:item.name,meta:item.meta,onClick:()=>{if(c.state.ctx.length>=3)return c.toast('Select up to three context items.');c.setState({ctx:c.state.ctx.some((x:any)=>x.id===item.id)?c.state.ctx:[...c.state.ctx,{id:item.id,kind:group.kind,label:item.name}],atOpen:false,input:c.state.input.replace(/@$/,'')});}}))}));v.activity=c.state.chats.flatMap((chat:any)=>chat.msgs.flatMap((m:any)=>(m.plan?.items || []).filter((item:any)=>item.status==='applied').map((item:any)=>({text:`Saved draft: ${item.title}`,meta:'Saved to templates',canUndo:false,dot:'display:block;width:7px;height:7px;margin-top:5px;border-radius:50%;background:oklch(0.58 0.14 155);'}))));v.rtCreate=()=>c.toast('Scheduled AI routines are not available yet.');
  v.composerNote='Chat history is saved. Type /compact to summarize earlier context.';
  v.skCreate=()=>{if(!c.state.skName.trim() || !c.state.skBody.trim())return;c.setState((s:any)=>({skills:[...s.skills,{id:crypto.randomUUID(),name:s.skName.trim(),body:s.skBody.trim(),on:true,uses:0}],skNewOpen:false,skName:'',skBody:''}));c.toast('Skill added. It will be saved with your next message.');};
  return v;
 };
 const unsubscribe=store.subscribe(()=>{if(!alive()){++sequence;active?.detach();active=undefined;if(!disposed)c.setState({chats:[],chatId:null,activity:[],skills:[],routines:[],mem:emptyMem(),busy:false});}});
 return()=>{disposed=true;++sequence;++loading;active?.detach();unsubscribe();};
}
