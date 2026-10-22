import type {DesignState} from './runtime';
import {store,getResource} from './store';
import {EditorAiConversation} from './EditorAiConversation';
import {errorMessage} from './Login';
import {aiIdentity,requestAi} from './ai-client';
type Controller=DesignState & Record<string,any>;
/** Behavior only: use the reference design's busy states, subject menu, canvas and Undo. */
export function installAiWriting(c:Controller,onChanged:()=>void){
  let disposed=false,active:ReturnType<typeof requestAi>|undefined,subjectSnapshot='';
  let undo:any=null,undoFingerprint='';
  c.state={...c.state,aiMessages:[],aiChatId:crypto.randomUUID()};
  c.props.overlay=EditorAiConversation;
  c.stopAiWriting=()=>void active?.cancel().catch((error:unknown)=>c.toast(errorMessage(error)));
  // Assistant bubbles list the concrete edits the agent's tools made, so replies can be checked against the canvas.
  const assistantText=(m:any)=>{const r=m.result,changes=r?.operation==='draft' && Array.isArray(r.changes)?r.changes:[];
    return [r?.message || m.text || m.error || (['queued','running'].includes(m.status)?'Working on your request...':'Unable to finish this request.'),...changes.map((x:string)=>`• ${x}`)].join('\n');};
  /** Body HTML of the canvas with editor CSS inlined: the document the AI agent edits. */
  /** Mark the block selected in the editor (in the exported copy only) so "this" means something to the AI. */
  const markSelection=(doc:Document)=>{
   const selected=c.ed?.getSelected(),el:Element|undefined=selected?.getEl?.();
   if(!el || selected.is?.('wrapper') || !el.tagName)return;
   const squash=(n:Element)=>(n.textContent || '').replace(/\s+/g,' ').trim(),same=(n:Element)=>n.tagName===el.tagName && squash(n)===squash(el) && n.getAttribute('href')===el.getAttribute('href') && n.getAttribute('src')===el.getAttribute('src');
   let matches=Array.from(doc.body.getElementsByTagName(el.tagName)).filter(same);
   if(matches.length>1){const peers=Array.from(el.ownerDocument.body.getElementsByTagName(el.tagName)).filter(same),index=peers.indexOf(el);matches=index>=0 && peers.length===matches.length?[matches[index]!]:[];}
   if(matches.length===1)matches[0]!.classList.add('vx-ai-selected');
  };
  const canvasHtml=(withSelection=false)=>{const doc=new DOMParser().parseFromString(c.exportEmail().html,'text/html'),first=doc.body.firstElementChild;if(first && /display:\s*none/.test(first.getAttribute('style') || ''))first.remove();if(withSelection){try{markSelection(doc);}catch{}}return doc.body.innerHTML.trim();};
  const addMessage=(role:string,text:string,failed=false)=>c.setState((state:any)=>({aiMessages:[...state.aiMessages,{id:crypto.randomUUID(),role,text,failed}]}));
  async function refreshHistory(){
    const data=await getResource(`/account/ai/chats/${c.state.aiChatId}`,true);if(disposed || owner!==aiIdentity())return;
    c.setState({aiMessages:data.messages.map((m:any)=>({id:m.id,role:m.role,text:m.role==='user'?m.text:assistantText(m),failed:m.role!=='user' && ['failed','timed_out','cancelled'].includes(m.status)}))});
    return data;
  }
  c.restoreAiWriting=async(id?:string,design?:unknown)=>{
    if(design)c.state.aiDesign=design;
    if(!id)return;c.setState({aiChatId:id,busy:true});
    try{const data=await refreshHistory();if(!design){const latest=data?.messages.filter((m:any)=>m.result?.operation==='draft').at(-1)?.result;if(latest){c.setState({aiDesign:latest.design,...(!new URLSearchParams(location.search).has('id')?{pendingAiDraft:latest}:{})});}}
      const pending=data?.messages.find((m:any)=>m.role==='assistant' && ['queued','running'].includes(m.status));
      if(pending && !active){const request=requestAi({},undefined,{runId:pending.run_id});active=request;c.setState({busy:true});try{const row=await request.promise;await refreshHistory();if(row.result.operation==='draft')c.setState({pendingAiDraft:row.result});}finally{active=undefined;if(!disposed)c.setState({busy:false});}}
    }catch(error){if(!disposed){if((error as any)?.status===404){const next=crypto.randomUUID();c.setState({aiChatId:next,aiMessages:[]});const url=new URL(location.href);url.searchParams.delete('ai_chat');history.replaceState({},'',url);}else c.toast(errorMessage(error));}}finally{if(!disposed && !active)c.setState({busy:false});}
  };
  const fingerprint=()=>JSON.stringify([c.state.subject,c.state.preheader,c.ed?.getProjectData()]);
  const valid=()=>!disposed && !!c.ed && !c.state.loading;
  const remember=()=>{undo={project:structuredClone(c.ed.getProjectData()),subject:c.state.subject,preheader:c.state.preheader,design:c.state.aiDesign};};
  async function run(operation:string,instruction='',mode=''){
    if(active)return c.toast('An AI request is already running.');
    if(!valid())return c.toast('Wait for the editor to finish loading.');
    // The exported text includes subject/preheader metadata; conversation context needs only visible canvas copy.
    let selected:any=null,text=operation==='draft'?(c.ed.getWrapper().getEl()?.innerText?.trim() || ''):c.exportEmail().text;
    if(operation==='rewrite'){
      selected=c.ed.getSelected();text=selected?.getEl()?.innerText?.trim() || '';
      if(!text)return c.toast('Select a text block to rewrite.');
      if(selected.find('a, img, button, input').length || selected.is('link'))return c.toast('Select a plain text paragraph or heading.');
      const el=selected.getEl();if(!['P','H1','H2','H3','H4','SPAN','DIV'].includes(el?.tagName) || (el?.children.length && !selected.is('text')))return c.toast('Select a plain text block.');
    }
    if(operation==='draft' && !instruction.trim())return c.toast('Add a writing brief first.');
    if(text.length>18000)return c.toast('This document is too long. Select a shorter block to rewrite.');
    const before=fingerprint(),owner=aiIdentity(),section=c.state.aiMode==='section';
    if(operation==='subjects')c.setState({subjMenu:true,subjBusy:true,subjOpts:[]});
    else c.setState(operation==='draft'?{busy:true}:{rwBusy:mode});
    const conversational=operation==='draft',html=conversational?canvasHtml(true):'';
    if(conversational && html.length>60000){c.setState({busy:false});return c.toast('This email is too large for the AI assistant. Remove unused sections or select a block to rewrite.');}
    const currentLinks=conversational?[...new Set(Array.from(new DOMParser().parseFromString(c.ed.getHtml(),'text/html').querySelectorAll('a[href]')).map(a=>a.getAttribute('href') || '').filter(value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol) && !url.username && !url.password;}catch{return false;}}))]:[];
    if(currentLinks.length>20){c.setState({busy:false});return c.toast('This email has too many links for conversational generation. Select a text block to rewrite.');}
    const brief=section && conversational?`Write a short additional email section, without a footer or sign-off. ${instruction}`:instruction;
    if(conversational){addMessage('user',instruction);c.setState({prompt:''});const url=new URL(location.href);url.searchParams.set('ai_chat',c.state.aiChatId);history.replaceState({},'',url);}
    c.setState({aiSteps:[]});
    const request=requestAi({operation:conversational?'editor':operation,instruction:brief,content:text,subject:c.state.subject,tone:c.state.tone || 'Friendly'},conversational?(_status,live)=>{if(!disposed)c.setState({aiSteps:live?.steps || []});}:undefined,conversational?{chatId:c.state.aiChatId,settings:{editor:{links:currentLinks,key:new URLSearchParams(location.search).get('id') || c.state.aiChatId,content:text.slice(0,6000),html,subject:c.state.subject,preheader:c.state.preheader || '',tone:c.state.tone || 'Friendly',section},timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}}:{});
    active=request;
    try{
      const row=await request.promise;
      if(!valid() || owner!==aiIdentity())return;
      if(conversational){await refreshHistory();if(disposed || owner!==aiIdentity())return;if(row.result.operation==='chat'){c.setState({prompt:''});return;} }
      if(fingerprint()!==before){if(conversational)c.setState({pendingAiDraft:row.result});return c.toast('The email changed while AI was writing. Generate again from the latest content.');}
      if(operation==='subjects'){subjectSnapshot=before;c.setState({subjOpts:row.result.subjects});return;}
      remember();
      if(operation==='rewrite'){
        if(!selected || !c.ed.getWrapper().contains(selected))return c.toast('The original block is no longer available.');
        selected.components(c.esc(row.result.text).replace(/\n/g,'<br>'));c.syncSel?.();
      }else{
        // The agent edits the whole canvas document in place (targeted tool edits), so apply it as one undoable step.
        c.ed.setComponents(row.result.html);c.setState({subject:row.result.subject || c.state.subject,preheader:row.result.preheader ?? c.state.preheader});
      }
      if(conversational)c.setState({prompt:''});
      undoFingerprint=fingerprint();onChanged();c.runReview?.();
      c.toast(row.warnings?.length?'AI draft added. Review the content and delivery checks before saving.':'AI suggestion added. Review before saving or sending.',true);
    }catch(error){if(!disposed && owner===aiIdentity()){if(conversational)addMessage('assistant',errorMessage(error),true);c.toast(errorMessage(error));}}
    finally{if(active===request){active=undefined;if(!disposed)c.setState({busy:false,rwBusy:null,subjBusy:false});}}
  }
  c.applyAiDraft=()=>{
    if(!c.state.pendingAiDraft || !valid() || active)return;
    const result=c.state.pendingAiDraft;remember();c.ed.setComponents(result.html);c.setState({subject:result.subject || c.state.subject,preheader:result.preheader ?? c.state.preheader,pendingAiDraft:null});undoFingerprint=fingerprint();onChanged();c.runReview?.();c.toast('Draft applied. Review before saving.',true);
  };
  c.generate=()=>void run('draft',c.state.prompt || '');
  c.newAiChat=()=>{
    if(active)return;
    c.setState({aiMessages:[],aiChatId:crypto.randomUUID(),pendingAiDraft:null,prompt:''});
    const url=new URL(location.href);url.searchParams.delete('ai_chat');history.replaceState({},'',url);onChanged();
  };
  c.suggestSubjects=()=>void run('subjects');
  c.rewrite=(mode:string)=>{
    const how:Record<string,string>={shorter:'Make it about half as long.',friendlier:'Make it warmer and friendlier.',punchier:'Make it direct and concise.',urgent:'Use a direct tone without inventing deadlines or scarcity.',grammar:'Fix grammar and spelling only.',personal:'Preserve existing merge tags. Do not add personal data or merge tags.',custom:c.state.instr || ''};
    if(mode==='custom' && !how.custom.trim())return c.toast('Add a rewrite instruction first.');
    void run('rewrite',how[mode] || 'Improve clarity.',mode);
  };
  c.bindAiValues=(values:any)=>{
    // The panel is a plain chat (EditorAiConversation); selecting text just opens it.
    values.aiOnSel=()=>c.setState({aiOpen:true});
    const previousUndo=values.undo;
    values.undo=()=>{
      if(undo && fingerprint()===undoFingerprint){const saved=undo;undo=null;c.ed.loadProjectData(saved.project);c.setState({subject:saved.subject,preheader:saved.preheader,aiDesign:saved.design,toast:null});onChanged();}
      else{undo=null;previousUndo();}
    };
    values.subjOptsV=c.state.subjOpts.map((text:string)=>({text,len:String(text.length),onClick:()=>{
      if(fingerprint()!==subjectSnapshot)return c.toast('The email changed. Generate new subjects.');
      remember();c.setState({subject:text,subjMenu:false});undoFingerprint=fingerprint();onChanged();c.toast('Subject updated',true);
    }}));
  };
  const owner=aiIdentity();const unsubscribe=store.subscribe(()=>{if(aiIdentity()!==owner){void active?.cancel().catch(()=>{});active=undefined;undo=null;if(!disposed)c.setState({busy:false,rwBusy:null,subjBusy:false,subjOpts:[],subjMenu:false,aiMessages:[],aiChatId:crypto.randomUUID(),aiDesign:undefined,pendingAiDraft:null});}});
  return ()=>{disposed=true;active?.detach();unsubscribe();};
}
