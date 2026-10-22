import {useLayoutEffect,useRef,useState,type KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import type {DesignState} from './runtime';
import './ai-chat.css';

/** Where a builder's AI chat mounts and which controller state and action drive it. Defaults: the email editor. */
export type AiPanelConfig={host:string;field:string;busy:string;send:string;placeholder:string;empty:string;applyLabel:string};
const EMAIL_PANEL:AiPanelConfig={host:'vb-ai-chat',field:'prompt',busy:'busy',send:'generate',placeholder:'Ask a question or describe a change…',empty:'Ask me to write this email, change its design, or answer a question about it.',applyLabel:'Apply saved AI draft to email'};
export const WORKFLOW_PANEL:AiPanelConfig={host:'wf-ai-chat',field:'aiPrompt',busy:'aiBusy',send:'aiBuild',placeholder:'Describe a workflow or ask for a change…',empty:'Describe the journey you want, or ask me to change this workflow.',applyLabel:'Apply saved AI draft to workflow'};

/** Friendly progress for the agent's latest tool step. */
const STEP_LABELS:Record<string,string>={reconnecting:'Reconnecting to your saved request',view_email:'Reading the email',read_element:'Reading the email',update_element:'Editing the email',insert_html:'Editing the email',replace_element:'Editing the email',remove_element:'Editing the email',write_email:'Writing the email',set_subject:'Writing the subject line',read_workspace:'Checking your workspace',view_workflow:'Reading the workflow',build_workflow:'Building the workflow',add_steps:'Adding steps',update_step:'Updating a step',remove_step:'Removing a step',set_trigger:'Setting the trigger',update_workflow_settings:'Updating settings'};
export const stepLabel=(steps:{name:string}[]|undefined)=>{const last=steps?.at(-1)?.name;return last?`${STEP_LABELS[last] || 'Working'}…`:'Thinking…';};

/** A plain chat: the conversation and one message box. Mounted into the builder's AI panel. */
const retryText=(messages:any[])=>[...messages].reverse().find(m=>m.role==='user')?.text as string|undefined;

export function EditorAiConversation({controller,panel=EMAIL_PANEL}:{controller:DesignState;panel?:AiPanelConfig}){
 const c=controller as DesignState & Record<string,any>;
 const [host,setHost]=useState<HTMLElement|null>(null);
 const log=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null);
 const messages=c.state.aiMessages || [],busy=!!c.state[panel.busy],value=String(c.state[panel.field] || ''),open=!!c.state.aiOpen;
 useLayoutEffect(()=>{const next=open?document.getElementById(panel.host):null;if(next!==host)setHost(next);});
 useLayoutEffect(()=>{if(log.current)log.current.scrollTop=log.current.scrollHeight;},[host,messages.length,busy]);
 useLayoutEffect(()=>{const el=input.current;if(!el)return;el.style.height='auto';el.style.height=`${Math.min(el.scrollHeight,160)}px`;},[host,value]);
 if(!host)return null;
 const send=()=>{if(!value.trim() || busy || c.state.aiReady===false)return;c[panel.send]();};
 const key=(event:KeyboardEvent<HTMLTextAreaElement>)=>{if(event.key==='Enter' && !event.shiftKey && !event.nativeEvent.isComposing){event.preventDefault();send();}};
 return createPortal(<section data-editor-ai-conversation="true" aria-label="AI conversation" className="ai-chat">
   <div ref={log} role="log" aria-live="polite" className="ai-chat-log">
    {!messages.length && <p className="ai-chat-empty">{panel.empty}</p>}
    {messages.length>0 && !busy && <button type="button" className="ai-chat-new" onClick={()=>c.newAiChat()}>New chat</button>}
    {messages.map((m:any,index:number)=>m.role==='user'?<div key={m.id} className="ai-chat-msg ai-chat-user">{m.text}</div>:
     <div key={m.id} className={`ai-chat-msg ai-chat-ai${m.failed?' ai-chat-failed':''}`}>{m.text}
      <div className="ai-chat-actions">
       {!m.failed && m.text && <button type="button" onClick={()=>void navigator.clipboard?.writeText(m.text).then(()=>c.toast('Copied'),()=>c.toast('Copy is not available in this browser.'))}>Copy</button>}
       {m.failed && index===messages.length-1 && !busy && retryText(messages) && <button type="button" onClick={()=>c.setState({[panel.field]:retryText(messages)},()=>c[panel.send]())}>Retry</button>}
      </div>
     </div>)}
    {busy && <div role="status" className="ai-chat-status"><span>{stepLabel(c.state.aiSteps)}</span><button type="button" onClick={()=>c.stopAiWriting()}>Stop</button></div>}
    {c.state.pendingAiDraft && !busy && <button type="button" className="ai-chat-apply" onClick={()=>c.applyAiDraft()}>{panel.applyLabel}</button>}
   </div>
   <div className="ai-chat-composer">
    <textarea ref={input} rows={1} value={value} placeholder={panel.placeholder} aria-label="Message the AI assistant" maxLength={4000}
     onChange={event=>c.setState({[panel.field]:event.target.value})} onKeyDown={key}/>
    <button type="button" aria-label="Send message" title="Send (Enter)" disabled={busy || !value.trim() || c.state.aiReady===false} onClick={send}>↑</button>
   </div>
 </section>,host);
}
