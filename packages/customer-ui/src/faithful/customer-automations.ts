import type {DesignState} from './runtime';
import {getResource,performAction} from './store';
import {readFeedback} from './read-feedback';
import {errorMessage} from './Login';
import {TRIGGERS} from './workflow-codec';
type Controller=DesignState & Record<string,any>;
// Label a workflow by its builder trigger, falling back to the published definition's event.
function triggerLabel(row:any){
 const byKey=TRIGGERS.find(t=>t.key===row.builder_trigger);if(byKey)return byKey.label;
 const event=String(row.trigger_event_type || '');
 if(event.startsWith('custom:')){const name=event.slice(7);return TRIGGERS.find(t=>t.event===name)?.label || `Event: ${name}`;}
 if(row.trigger_type==='event' && event)return `Email ${event.replace(/^email\./,'')}`;
 return row.trigger_type==='manual' || row.trigger_type==='api'?'API or manual start':'Not configured';
}
export function installCustomerAutomations(c:Controller){
 const original=c.automationsVals.bind(c);let disposed=false,busy=false,rows:any[]=[];
 async function refresh(){try{const result=await getResource('/account/data/workflows?limit=200',true);if(disposed)return;rows=result.workflows.filter((row:any)=>row.status!=='archived');c.setState({autos:rows.map(row=>({...row,status:row.status==='active'?'Active':row.status==='paused'?'Paused':'Draft',trigger:triggerLabel(row),entered:row.total_runs,sent:0,open:0,conv:0,rev:0,steps:[]}))});readFeedback(c,'automations');}catch(error){if(!disposed)readFeedback(c,'automations',error);}}
 c.automationsVals=()=>{const values=original();if(c.state.view!=='automations')return values;values.recipes=[];values.hasRecipes=false;values.aKpis=values.aKpis.map((row:any,index:number)=>({...row,value:index===0?String(rows.reduce((sum,row)=>sum+row.total_runs,0)):'—',delta:''}));values._newAuto=()=>location.assign('/workflow-builder');values.aRows=values.aRows.map((row:any)=>({...row,stepCount:String(rows.find(r=>r.id===row.id)?.builder_steps ?? '—'),sentFmt:'—',openFmt:'—',convFmt:'—',revFmt:'—',onEdit:()=>location.assign(`/workflow-builder?id=${row.id}`),onToggle:()=>void(async()=>{if(busy)return;if(row.status==='Draft')return location.assign(`/workflow-builder?id=${row.id}`);busy=true;try{await performAction(`/account/data/workflows/${row.id}/${row.status==='Active'?'pause':'resume'}`,{});await refresh();}catch(error){if(!disposed)c.toast(errorMessage(error));}finally{busy=false;}})()}));return values;};
 return {mount(){if(c.state.view==='automations')void refresh();},refresh:()=>c.state.view==='automations'?refresh():Promise.resolve(),changed(previous:any){if(previous.view!==c.state.view && c.state.view==='automations')void refresh();},dispose(){disposed=true;}};
}
