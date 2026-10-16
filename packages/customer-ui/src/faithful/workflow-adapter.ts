import type {DesignState} from './runtime';
import {getResource,performAction} from './store';
import {errorMessage} from './Login';
import {compileWorkflow} from './workflow-codec';
import {WorkflowHistory} from './WorkflowHistory';
type Controller=DesignState & Record<string,any>;
export function prepareWorkflow(base:DesignState){
 const c=base as Controller,original=c.renderVals.bind(c),change=c.change.bind(c);let disposed=false,ready=false,dirty=false,conflicted=false,id=new URLSearchParams(location.search).get('id'),revision=0,from='',saving:Promise<void>|null=null,timer:ReturnType<typeof setTimeout>|undefined;
 const blank=()=>c.norm({id:'draft',name:`Untitled workflow ${crypto.randomUUID().slice(0,8)}`,tkey:'event',status:'Draft',steps:[],settings:{...c.DEF_SET,quiet:false,cap:false,goal:'none'}});
 c.TRIG=[['event','Custom API event','Developer'],['opened','Email opened','Engagement'],['clicked','Email clicked','Engagement'],['delivered','Email delivered','Engagement']];
 c.CONDS=[['activated','Context: onboarding_complete is true'],['score','Context: score is at least 50']];
 const newNode=c.newNode.bind(c);c.newNode=(type:string)=>{const node=newNode(type);return type==='branch'?{...node,cond:'activated'}:type==='filter'?{...node,rule:'score'}:node;};
 c.props.overlay=WorkflowHistory;
 let historySequence=0;
 c.refreshWorkflowHistory=async(offset=0)=>{if(!id)return c.toast('Save the workflow before viewing history.');const sequence=++historySequence,previous=c.state.workflowHistory || {runs:[],versions:[],total:0};c.setState({workflowHistory:{...previous,offset,busy:true,error:''}});try{const [runs,versions]=await Promise.all([getResource(`/account/data/workflows/${id}/runs?limit=50&offset=${offset}`,true),getResource(`/account/data/workflows/${id}/versions`,true)]);if(!disposed && sequence===historySequence)c.setState({workflowHistory:{runs:runs.runs,total:runs.total,versions:versions.versions,offset,busy:false,error:''}});}catch(error){if(!disposed && sequence===historySequence)c.setState({workflowHistory:{...previous,offset,busy:false,error:errorMessage(error)}});}};
 c.cancelHistoryRun=async(runId:string)=>{if(c.state.workflowHistory?.busy || !window.confirm('Stop future steps for this run? Already queued mail cannot be recalled.'))return;const previous=c.state.workflowHistory;c.setState({workflowHistory:{...previous,busy:true}});try{await performAction(`/account/data/workflows/runs/${runId}/cancel`,{});await c.refreshWorkflowHistory(previous.offset);}catch(error){if(!disposed)c.setState({workflowHistory:{...previous,busy:false,error:errorMessage(error)}});}};
 c.validate=(workflow:any)=>{try{compileWorkflow(workflow,from);return [];}catch(error){return [{id:'trigger',level:'error',text:errorMessage(error),where:'Workflow'}];}};
 c.state={...c.state,wfs:[blank()],curId:'draft',modal:null,savedAt:null};
 const snapshot=()=>JSON.stringify({name:c.cur().name,graph:c.cur().graph,settings:c.cur().settings,tkey:c.cur().tkey});
 c.change=(...args:any[])=>{if(ready)change(...args);};
 c.saveBuilder=()=>{
  if(saving)return saving;if(!ready || !dirty || conflicted)return Promise.resolve();
  saving=(async()=>{const document=structuredClone(c.cur()),sent=snapshot();c.setState({builderSaving:true});
   try{
    if(!id){const row=await performAction('/account/data/workflows',{name:document.name});id=row.id;if(disposed)return;c.setState({curId:id,wfs:[{...c.cur(),id}]});history.replaceState({},'',`/workflow-builder?id=${encodeURIComponent(id!)}`);}
    const result=await performAction(`/account/data/workflows/${id}/builder`,{expected_revision:revision,name:document.name,document},'PUT');revision=result.builder_revision;
    if(!disposed){dirty=snapshot()!==sent;c.setState({savedAt:new Date(),builderError:''});}
   }catch(error:any){if(!disposed){conflicted=error?.status===409;c.setState({builderError:errorMessage(error)});c.toast(errorMessage(error));}}
   finally{saving=null;if(!disposed){c.setState({builderSaving:false});if(dirty && !conflicted && !c.state.builderError)c.persist();}}
  })();return saving;
 };
 c.persist=()=>{if(disposed)return;dirty=true;clearTimeout(timer);timer=setTimeout(()=>void c.saveBuilder(),750);c.setState({});};
 const beforeUnload=(event:BeforeUnloadEvent)=>{if(dirty || saving){event.preventDefault();event.returnValue='';}};
 c.componentDidMount=()=>{
  window.addEventListener('beforeunload',beforeUnload);window.addEventListener('pointermove',c.onMove);window.addEventListener('pointerup',c.onUp);
  c.onKey=(event:KeyboardEvent)=>{if((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==='s'){event.preventDefault();void c.saveBuilder();}if(event.key==='Escape')c.setState({modal:null,dd:null});};window.addEventListener('keydown',c.onKey);
  const canvas=c.canvasRef.current;if(canvas){canvas.addEventListener('wheel',c.onWheel,{passive:false});c._wheelEl=canvas;}
  void(async()=>{try{
    const [templates,domains]=await Promise.all([getResource('/account/data/templates',true),getResource('/account/domains',true)]);if(disposed)return;c.TEMPLATES=templates.templates.map((row:any)=>row.id);const domain=domains.domains.find((row:any)=>row.verified_at);from=domain?`hello@${domain.domain}`:'';
    if(id){const row=await getResource(`/account/data/workflows/${encodeURIComponent(id)}/builder`,true);if(disposed)return;revision=row.builder_revision;const workflow=c.norm({...blank(),...(row.builder_document || {}),id:row.id,name:row.name,status:row.status==='active'?'Active':row.status==='paused'?'Paused':'Draft'});c.setState({wfs:[workflow],curId:row.id,savedAt:row.builder_document?new Date(row.updated_at):null});}
    ready=true;c.setState({});c.fit();
   }catch(error){if(!disposed)c.setState({builderError:errorMessage(error)});}})();
 };
 async function publish(){await c.saveBuilder();if(!id || dirty || conflicted)throw new Error(c.state.builderError || 'Save the latest draft before publishing.');const definition=compileWorkflow(c.cur(),from);const result=await performAction(`/account/data/workflows/${id}/builder/publish`,{expected_revision:revision,definition});revision=result.builder_revision;if(!disposed){c.setState({wfs:[{...c.cur(),status:'Active'}],modal:null});c.toast(`Published version ${result.version}. Waiting for real trigger events.`);}}
 let actionBusy=false;
 const action=(fn:()=>Promise<void>)=>void(async()=>{if(actionBusy || !ready)return;actionBusy=true;try{await fn();}catch(error){if(!disposed)c.toast(errorMessage(error));}finally{actionBusy=false;}})();
 c.aiBuild=c.aiSubject=()=>c.toast('AI generation is not connected to a production provider.');
 c.renderVals=()=>{const values=original();values.subText=c.state.builderError || (!ready?'Loading workspace workflow…':c.state.builderSaving?'Saving to workspace…':dirty?'Unsaved workflow changes':c.state.savedAt?'Saved to workspace':'New unsaved draft');values.openGallery=()=>c.toast('Recipe drafts require manual review; use the step palette to build your workflow.');values.primary=()=>action(async()=>{if(c.cur().status==='Active'){await performAction(`/account/data/workflows/${id}/pause`,{});if(!disposed)c.setState({wfs:[{...c.cur(),status:'Paused'}]});}else c.setState({modal:'activate'});});values.confirmActivate=()=>action(publish);values.actOpts=values.actOpts.slice(0,1).map((row:any)=>({...row,hint:'Starts only on real incoming API or engagement events. No existing audience is enrolled automatically.'}));values.liveNote='Edits are draft changes. Publish again to create an immutable live version. Existing runs keep their original version.';values.settings=[];values.suggestions=[];values.noSuggestions=true;values.aiReviewHead='No production AI review has run.';values.palette=values.palette.map((group:any)=>({...group,items:group.items.filter((item:any)=>['Email','Wait','A/B split','Webhook'].includes(item.label))})).filter((group:any)=>group.items.length);
  values.palette=original().palette.map((group:any)=>({...group,items:group.items.filter((item:any)=>['Send email','Wait','If / else','Filter','A/B split','Webhook'].includes(item.label))})).filter((group:any)=>group.items.length);
  values.pTabs=[...values.pTabs,{label:'Runs & versions',style:values.pTabs[0]?.style,onClick:()=>void c.refreshWorkflowHistory(0)}];
  values.openTest=()=>action(async()=>{await c.saveBuilder();if(!id || dirty)throw new Error('Save the latest draft first.');const result=await performAction(`/account/data/workflows/${id}/simulate`,{definition:compileWorkflow(c.cur(),from),subject_email:'simulation@example.test'});if(!disposed)c.setState({modal:'test',productionSimulation:result.simulation});});values.personas=[];values.simSummary=c.state.productionSimulation?'Server dry run only. No mail or webhooks were sent.':'';values.sim=(c.state.productionSimulation?.path || []).map((step:any)=>({when:`+${step.virtual_elapsed_seconds}s`,title:step.step_type,note:step.outcome,hasNote:true,dot:'background:#738095;width:10px;height:10px;border-radius:50%;'}));return values;};
 return ()=>{disposed=true;clearTimeout(timer);window.removeEventListener('beforeunload',beforeUnload);};
}
