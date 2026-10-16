import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {DesignState} from './runtime';
import {visibleReadErrors} from './read-feedback';
import {ListAssignment} from './ListAssignment';
import './customer-overlays.css';
type Controller=DesignState & Record<string,any>;
function WorkspaceFeedback({controller:c}:{controller:Controller}){
  const [online,setOnline]=useState(navigator.onLine);
  useEffect(()=>{const update=()=>setOnline(navigator.onLine);window.addEventListener('online',update);window.addEventListener('offline',update);return ()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
  const errors=visibleReadErrors(c);
  if(online && !errors.length)return null;
  return <aside className="workspace-feedback" role="status" aria-live="polite"><div><strong>{online?'Workspace data could not be refreshed':'You are offline'}</strong><p>{online?errors[0]+' Previously loaded data may be out of date.':'Reconnect before saving changes. Unsaved form values are kept on this page.'}</p></div>{online && <button disabled={!!c.state.productionRefreshing} onClick={()=>void c.refreshWorkspace?.()}>{c.state.productionRefreshing?'Refreshing…':'Retry refresh'}</button>}</aside>;
}
export function CustomerOverlays({controller}:{controller:DesignState}){
  const c=controller as Controller,form=c.state.productionContactForm,importer=c.state.productionImport;
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!form && !importer)return;
    const previous=document.activeElement as HTMLElement|null;
    const controls=()=>Array.from(ref.current?.querySelectorAll<HTMLElement>('input,select,button,a[href],textarea') || []).filter(element=>!element.hasAttribute('disabled'));
    controls()[0]?.focus();
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!c.state.productionContactBusy)c.setState({productionContactForm:null,productionImport:null});}
      if(event.key==='Tab'){const fields=controls(),first=fields[0],last=fields.at(-1);if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}}
    };
    document.addEventListener('keydown',key,true);
    return ()=>{document.removeEventListener('keydown',key,true);previous?.focus();};
  },[!!form,!!importer,c]);
  if(!form && !importer)return <><WorkspaceFeedback controller={c}/><ListAssignment controller={c}/></>;
  const busy=!!c.state.productionContactBusy;
  const set=(patch:Record<string,unknown>)=>c.setState({productionContactForm:{...c.state.productionContactForm,...patch},productionContactError:''});
  const submit=(event:FormEvent)=>{event.preventDefault();void (form?c.submitContact():c.submitContactImport());};
  return <><WorkspaceFeedback controller={c}/><div className="customer-overlay"><div ref={ref} role="dialog" aria-modal="true" aria-labelledby="contact-form-title" aria-describedby="contact-form-help" className="customer-dialog"><header><h2 id="contact-form-title">{form?'Add contact':'Import contacts'}</h2><button type="button" aria-label="Close dialog" disabled={busy} onClick={()=>c.setState({productionContactForm:null,productionImport:null})}>×</button></header><p id="contact-form-help">{form?'Save a contact to this workspace. Pending contacts have not confirmed marketing consent.':'Upload a UTF-8 CSV with an email column and name, or first_name and last_name. Up to 200 rows per import. Contacts default to Pending.'}</p><form onSubmit={submit} aria-busy={busy}>
    {form?<><label>Name<input name="contact-name" autoComplete="name" value={form.name} onChange={event=>set({name:event.target.value})} maxLength={200} required disabled={busy}/></label><label>Email<input name="contact-email" autoComplete="email" type="email" value={form.email} onChange={event=>set({email:event.target.value})} maxLength={320} required disabled={busy}/></label><div className="contact-pair"><label>Company<input value={form.company} onChange={event=>set({company:event.target.value})} maxLength={200} disabled={busy}/></label><label>Location<input value={form.location} onChange={event=>set({location:event.target.value})} maxLength={200} disabled={busy}/></label></div><label>Marketing email status<select value={form.status} onChange={event=>set({status:event.target.value,consent_confirmed:false})} disabled={busy}><option>Pending</option><option>Subscribed</option><option>Unsubscribed</option></select></label>{form.status==='Subscribed' && <label className="contact-consent"><input type="checkbox" checked={form.consent_confirmed} onChange={event=>set({consent_confirmed:event.target.checked})} required disabled={busy}/>I have documented consent to send marketing email to this contact.</label>}</>:<><label>CSV file<input name="contacts-csv" type="file" accept=".csv,text/csv" disabled={busy} onChange={event=>{const file=event.target.files?.[0];if(file)void c.readContactCsv(file);}} required /></label>{importer.rows?.length>0 && <p role="status">{importer.rows.length} contacts ready to import from {importer.filename}.</p>}<label className="contact-consent"><input type="checkbox" checked={!!importer.consent_confirmed} onChange={event=>c.setState({productionImport:{...c.state.productionImport,consent_confirmed:event.target.checked}})} disabled={busy}/>I have documented marketing consent for CSV rows marked Subscribed.</label></>}
    {c.state.productionContactError && <p role="alert" className="contact-error">{c.state.productionContactError}</p>}<footer><button type="button" disabled={busy} onClick={()=>c.setState({productionContactForm:null,productionImport:null})}>Cancel</button><button className="contact-primary" disabled={busy || (!form && !importer.rows?.length)}>{busy?'Saving…':form?'Add contact':`Import ${importer.rows?.length || 0} contacts`}</button></footer>
  </form></div></div></>;
}
