import {useLayoutEffect,useState,useRef} from 'react';
import {createPortal} from 'react-dom';
import type {DesignState} from './runtime';

/** Conversation added inside the existing panel; its navigation and editor layout stay intact. */
export function EditorAiConversation({controller:c}:{controller:DesignState}){
 const [host,setHost]=useState<HTMLElement|null>(null);
 const log=useRef<HTMLDivElement>(null),messages=c.state.aiMessages || [];
 useLayoutEffect(()=>{if(log.current)log.current.scrollTop=log.current.scrollHeight;},[host,messages.length,c.state.busy]);
 const visible=c.state.aiOpen && c.state.aiTab==='write';
 useLayoutEffect(()=>{
  if(!visible)return;
  const textarea=document.querySelector('textarea.ref-email-10');if(!textarea?.parentElement)return;
  const mount=document.createElement('div');mount.dataset.editorAiConversation='true';
  textarea.parentElement.insertBefore(mount,textarea.previousElementSibling || textarea);setHost(mount);
  return ()=>{mount.remove();setHost(null);};
 },[visible]);
 if(!host || !visible)return null;
 return createPortal(<section aria-label="Template AI conversation" style={{marginBottom:16,fontSize:13,lineHeight:1.55}}>
   {messages.length>0 && <div ref={log} role="log" aria-live="polite" style={{maxHeight:260,overflowY:'auto',display:'flex',flexDirection:'column',gap:8,paddingBottom:8}}>
    {messages.map((m:any)=><div key={m.id} style={{alignSelf:m.role==='user'?'flex-end':'stretch',maxWidth:'100%',padding:'9px 11px',borderRadius:9,background:m.role==='user'?'#f0edfb':'#f7f8f9',color:'#2a2f3a',whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}><strong style={{display:'block',fontSize:11,color:'#7b8497',marginBottom:3}}>{m.role==='user'?'You':'AI assistant'}</strong><span>{m.text}</span></div>)}
   </div>}
   {c.state.busy && <div role="status" style={{color:'#7b8497',display:'flex',justifyContent:'space-between'}}>Working on your request...<button type="button" onClick={()=>(c as any).stopAiWriting()} style={{border:'1px solid #e3e5e9',borderRadius:7,background:'#fff',padding:'3px 10px',font:'inherit',cursor:'pointer'}}>Stop</button></div>}
   {c.state.pendingAiDraft && !c.state.busy && <button type="button" onClick={()=>(c as any).applyAiDraft()} style={{border:'1px solid #5a45b8',borderRadius:8,background:'#6e56cf',color:'#fff',padding:'8px 12px',font:'inherit',cursor:'pointer'}}>Apply saved AI draft to email</button>}

 </section>,host);
}
