import type {DesignState} from './runtime';
import {getResource,performAction,store} from './store';
import {errorMessage} from './Login';
import {readFeedback} from './read-feedback';
type Controller=DesignState & Record<string,any>;
export function installCustomerAudiences(c:Controller){
 const original=c.segListVals.bind(c);let disposed=false,busy=false,rows:any[]=[];
 const writable=()=>['owner','admin','developer'].includes(store.getState().session.identity?.current_role || '');
 async function refresh(){try{const response=await getResource('/account/data/audiences',true);if(disposed)return;rows=response.collections;readFeedback(c,'audiences');c.setState({segs:rows.filter(row=>row.kind==='segment').map(row=>({...row,rules:row.rules.map((rule:any)=>`${rule.field} ${rule.op} ${rule.val}`),trend:''})),lists:rows.filter(row=>row.kind==='list').map(row=>({...row,source:'Manual',updated:new Date(row.updated_at).toLocaleDateString()}))});}catch(error){if(!disposed)readFeedback(c,'audiences',error);}}
 async function write(action:()=>Promise<void>){if(busy)return;if(!writable())return c.toast('Your role cannot change audiences.');busy=true;try{await action();}catch(error){if(!disposed)c.toast(errorMessage(error));}finally{busy=false;}}
 c.saveAudience=()=>write(async()=>{const kind=c.state.view==='segments'?'segment':'list';await performAction('/account/data/audiences',{kind,name:c.state.sgName.trim(),rules:kind==='segment'?c.state.sgRules:[]});if(disposed)return;c.setState({sgModal:false});await refresh();c.toast('Audience saved');});
 c.segListVals=(view:string)=>{
  const values=original(view);if(!['lists','segments'].includes(view))return values;
  values.sgCreate=c.saveAudience;values.sgEstimate='Calculated from saved rules';
  const fields=['Created','Opened any email','Clicked any email'],days=['7 days','30 days','60 days','90 days','120 days'];
  values.sgRules=c.state.sgRules.map((rule:any,index:number)=>({...values.sgRules[index],...rule,onField:()=>c.setState({sgRules:c.state.sgRules.map((r:any,i:number)=>i===index?{...r,field:fields[(fields.indexOf(r.field)+1)%fields.length],op:'in last',val:'30 days'}:r)}),onOp:()=>c.setState({sgRules:c.state.sgRules.map((r:any,i:number)=>i===index?{...r,op:r.op==='in last'?'not in last':'in last'}:r)}),onVal:()=>c.setState({sgRules:c.state.sgRules.map((r:any,i:number)=>i===index?{...r,val:days[(days.indexOf(r.val)+1)%days.length]}:r)})}));
  values.sgAddRule=()=>c.setState({sgRules:[...c.state.sgRules,{field:'Created',op:'in last',val:'7 days'}]});
  const subset=rows.filter(row=>row.kind===(view==='segments'?'segment':'list'));
  values.slCards=values.slCards.map((card:any,index:number)=>({...card,trend:view==='segments'?'Live count':'Static list',onDelete:()=>{if(window.confirm(`Delete ${subset[index].name}? Contacts and consent are retained.`))void write(async()=>{await performAction(`/account/data/audiences/${subset[index].id}`,undefined,'DELETE');await refresh();});},onSend:()=>{if(!writable())return c.toast('Your role cannot create campaigns.');c.go('campaigns');c.setState({newCampOpen:true,nc:{name:'',type:'Regular',audience:subset[index].id}});}}));
  return values;
 };
 c.openListAssignment=()=>void(async()=>{if(!writable())return;c.setState({productionListAssignment:null});try{const result=await getResource('/account/data/audiences',true),lists=result.collections.filter((row:any)=>row.kind==='list');if(!lists.length)return c.toast('Create a list before assigning contacts.');if(!disposed)c.setState({productionListAssignment:{lists,id:lists[0].id,ids:Object.keys(c.state.ctSel).filter(id=>c.state.ctSel[id]),error:'',busy:false}});}catch(error){if(!disposed)c.toast(errorMessage(error));}})();
 c.assignList=()=>write(async()=>{const form=c.state.productionListAssignment;if(!form || form.busy)return;c.setState({productionListAssignment:{...form,busy:true}});try{await performAction(`/account/data/audiences/${form.id}/members`,{ids:form.ids,action:'add'});if(!disposed){c.setState({productionListAssignment:null,ctSel:{}});await c.refreshWorkspace();if(!disposed)c.toast('Contacts added to list');}}catch(error){if(!disposed)c.setState({productionListAssignment:{...form,busy:false,error:errorMessage(error)}});}});
 return {mount(){if(['lists','segments'].includes(c.state.view))void refresh();},refresh:()=>['lists','segments'].includes(c.state.view)?refresh():Promise.resolve(),changed(previous:any){if(previous.view!==c.state.view && ['lists','segments'].includes(c.state.view))void refresh();},dispose(){disposed=true;}};
}
