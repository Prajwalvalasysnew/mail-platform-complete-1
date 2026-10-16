import type { DesignState } from './runtime';
import { errorMessage } from './Login';
import { getResource, performAction, store } from './store';

type Controller = DesignState & Record<string, any>;
const EMPTY_EMAIL = '<div class="email" style="max-width:600px;margin:24px auto;background:#fff;min-height:400px;border-radius:12px;padding:32px"><p style="font-family:Arial,sans-serif;color:#444">Add your email content here.</p></div>';

export function prepareEmail(base: DesignState) {
  const c = base as Controller;
  const originalInit = c.initEditor.bind(c);
  const originalVals = c.renderVals.bind(c);
  let disposed = false;
  let saving: Promise<void> | null = null;
  let templateId = new URLSearchParams(location.search).get('id');
  let revision: number | undefined;
  let initial: any = null;
  let dirty = false;
  const name = store.getState().session.identity?.memberships.find(m => m.customer_id === store.getState().session.identity?.current_customer_id)?.org_name || '';
  c.props.textOverrides={'No saved versions yet. Press Save or ⌘S to keep a restore point. Edits autosave as you work.':'No saved versions yet. Press Save or ⌘S to save this template to your workspace.'};
  c.state = { ...c.state, name:'Untitled template', fromName:name, subject:'', preheader:'', testTo:store.getState().session.identity?.user.email || '', versions:[], savedAt:null, loadNote:'Loading template…' };
  async function versions() {
    if (!templateId) return;
    const result = await getResource(`/account/data/templates/${encodeURIComponent(templateId)}/versions`,true);
    if (!disposed) c.setState({versions:result.versions.map((v:any)=>({id:v.id,revision:v.revision,label:v.subject || v.name,when:v.created_at}))});
  }
  c.initEditor = (grapes:any) => {
    originalInit({ ...grapes, init:(config:any)=>grapes.init({
      ...config, storageManager:false, allowScripts:false,
      components:initial?.html_body || EMPTY_EMAIL,
      // Load before the first canvas render. Replacing pages from the load
      // callback can detach the newly rendered frame in GrapesJS 0.23.
      // RTK Query responses are immutable; GrapesJS mutates page/frame data
      // as it creates its models, so never give it the Redux-owned object.
      projectData:initial?.editor_document?.project ? structuredClone(initial.editor_document.project) : undefined,
    }) });
    c.ed.on('load',()=>{
      c.ed.UndoManager.clear(); dirty=false;
      c.setState({savedAt:initial?.updated_at ? new Date(initial.updated_at):null,loading:false});
      c.ed.on('update',()=>{dirty=true;c.setState({});});
    });
  };
  c.componentDidMount = () => {
    window.addEventListener('beforeunload',beforeUnload);
    c.onKey=(event:KeyboardEvent)=>{if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase()==='s') {event.preventDefault();void c.saveVersion();} if(event.key==='Escape' && c.state.modal)c.setState({modal:null});};
    window.addEventListener('keydown',c.onKey);
    void (async()=>{
      try {
        if (templateId) {
          initial=await getResource(`/account/data/templates/${encodeURIComponent(templateId)}`,true);
          if(disposed)return;
          revision=initial.revision;
          c.setState({name:initial.name,subject:initial.subject,preheader:initial.editor_document?.preheader || '',fromName:initial.editor_document?.fromName || name});
          await versions();
        }
        if(disposed)return;
        const grapes=(window as any).grapesjs;
        if(!grapes)throw new Error('The email editor could not be loaded. Reload to try again.');
        c.initEditor(grapes);
      } catch(error) { if(!disposed)c.setState({loading:true,loadNote:errorMessage(error)}); }
    })();
  };
  // The exported controller writes globally keyed metadata from didUpdate.
  // Production documents use only tenant-scoped server storage.
  c.componentDidUpdate=()=>c.pushPreview();
  c.saveVersion=()=>{
    if(saving)return saving;
    if(!c.ed || c.state.loading)return Promise.resolve();
    if(!c.state.name.trim() || !c.state.subject.trim()){c.toast('Add a template name and subject before saving.');return Promise.resolve();}
    const document=c.exportEmail();
    const payload={name:c.state.name.trim(),subject:c.state.subject,html_body:document.html,text_body:document.text,
      editor_document:{schemaVersion:1,project:c.ed.getProjectData(),preheader:c.state.preheader,fromName:c.state.fromName},
      ...(revision!=null?{expected_revision:revision}:{}),
    };
    const savedState={name:c.state.name,subject:c.state.subject,preheader:c.state.preheader,fromName:c.state.fromName,project:JSON.stringify(payload.editor_document.project)};
    c.setState({saving:true});
    saving=(async()=>{
      try {
        const result=await performAction(templateId?`/account/data/templates/${encodeURIComponent(templateId)}`:'/account/data/templates',payload,templateId?'PUT':'POST');
        templateId=result.id;revision=result.revision;
        if(disposed)return;
        const url=new URL(location.href);url.searchParams.set('id',templateId!);history.replaceState({},'',url);
        dirty=c.state.name!==savedState.name || c.state.subject!==savedState.subject || c.state.preheader!==savedState.preheader || c.state.fromName!==savedState.fromName || JSON.stringify(c.ed.getProjectData())!==savedState.project;
        c.setState({savedAt:new Date()});
        await versions();
        c.toast(dirty?'Version saved. You have newer unsaved changes.':'Version saved');
      } catch(error) { if(!disposed)c.toast(errorMessage(error)); }
      finally {saving=null;if(!disposed)c.setState({saving:false});}
    })();
    return saving;
  };
  c.restoreVersion=(version:any)=>void (async()=>{
    if(!templateId)return;
    try {
      const snapshot=await getResource(`/account/data/templates/${encodeURIComponent(templateId)}/versions/${version.revision}`,true);
      if(disposed)return;
      if(snapshot.editor_document?.project)c.ed.loadProjectData(structuredClone(snapshot.editor_document.project));
      else c.ed.setComponents(snapshot.html_body || EMPTY_EMAIL);
      dirty=true;
      c.setState({name:snapshot.name,subject:snapshot.subject,preheader:snapshot.editor_document?.preheader || '',fromName:snapshot.editor_document?.fromName || name,sel:null});
      c.toast('Version restored to the editor. Save to create a new version.');
    }catch(error){if(!disposed)c.toast(errorMessage(error));}
  })();
  c.generate=()=>c.toast('AI writing is not configured for this workspace.');
  c.rewrite=c.suggestSubjects=c.generate;
  c.renderVals=()=>{
    const values=originalVals();
    values.save=c.saveVersion;
    values.statusText=c.state.loading?'Loading…':c.state.saving?'Saving…':dirty?'Unsaved changes':c.state.savedAt?'Saved '+c.ago(c.state.savedAt):'Unsaved draft';
    for(const field of ['Name','From','Subject','Preheader']) {
      const key=`on${field}`;const previous=values[key];
      if(previous)values[key]=(event:Event)=>{dirty=true;previous(event);};
    }
    values.sendTest=()=>void (async()=>{
      if(c.state.sendingTest)return;
      const recipients=c.state.testTo.split(',').map((s:string)=>s.trim()).filter(Boolean);
      if(!recipients.length || recipients.length>5 || recipients.some((s:string)=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)))return c.setState({testErr:'Enter between one and five valid email addresses.'});
      c.setState({sendingTest:true,testErr:''});
      try {
        const domains=await getResource('/account/domains',true);
        const sender=domains.domains.find((d:any)=>d.verified_at || d.status==='verified');
        if(!sender)throw new Error('Verify a sending domain in Settings before sending a test.');
        const content=c.exportEmail();
        await performAction('/account/data/send',{from:`hello@${sender.domain}`,from_name:c.state.fromName,to:recipients,subject:c.state.subject,html:c.fill(content.html),text:c.fill(content.text)});
        if(!disposed){c.setState({modal:null});c.toast('Test queued. Check Messages for its delivery status.');}
      }catch(error){if(!disposed)c.setState({testErr:errorMessage(error)});}
      finally{if(!disposed)c.setState({sendingTest:false});}
    })();
    return values;
  };
  const beforeUnload=(event:BeforeUnloadEvent)=>{if(dirty || saving){event.preventDefault();event.returnValue='';}};
  return ()=>{disposed=true;window.removeEventListener('beforeunload',beforeUnload);};
}
