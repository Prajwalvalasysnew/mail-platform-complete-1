import type {DesignState} from './runtime';
import {getResource,performAction,store} from './store';
import {errorMessage} from './Login';
import {parseContactCsv} from './contact-csv';
import {readFeedback} from './read-feedback';
type Controller=DesignState & Record<string,any>;
export function installCustomerContacts(c:Controller){
  const original=c.contactsVals.bind(c);
  const writable=()=>['owner','admin','developer'].includes(store.getState().session.identity?.current_role || '');
  const denied=()=>c.toast('Your role has read-only access to contacts. Ask a workspace administrator to make changes.');
  let disposed=false,pending=false,loaded=false,failure='',upload=0,stats:any={total:0,subscribed:0,unsubscribed:0,bounced:0,new_month:0},next:number|null=null;
  let readSequence=0,reading:Promise<void>|null=null;
  async function refresh(append=false){
    const sequence=++readSequence;
    try{
    const response=await getResource(`/account/data/contacts?limit=200&offset=${append?next || 0:0}`,true);
    if(disposed || sequence!==readSequence)return;
    stats=response.stats;loaded=true;failure='';next=response.next_offset;
    readFeedback(c,'contacts');
    const records=response.contacts.map((row:any)=>({...row,email:row.email,name:row.name || row.email,status:row.effective_status,eng:0,lists:row.list_names || [],last:new Date(row.updated_at),created:new Date(row.created_at)}));
    const contacts:any[]=append?[...new Map([...c.state.contacts,...records].map(row=>[row.id,row])).values()]:records;
    c.setState({contacts,ctPage:Math.min(c.state.ctPage || 0,Math.max(0,Math.ceil(contacts.length/10)-1)),ctSel:Object.fromEntries(Object.entries(c.state.ctSel || {}).filter(([id])=>contacts.some(row=>row.id===id))),...(contacts.some(row=>row.id===c.state.ctOpen)?{}:{ctOpen:null})});
    }catch(error){if(!disposed && sequence===readSequence){failure=errorMessage(error);readFeedback(c,'contacts',error);c.setState({});}throw error;}
  }
  async function run(action:()=>Promise<void>,form=false){
    if(!writable()){denied();return;}
    if(pending)return;pending=true;if(form)c.setState({productionContactBusy:true,productionContactError:''});
    try{await action();}catch(error){if(!disposed){const message=errorMessage(error);if(form)c.setState({productionContactError:message});else{failure=message;c.toast(message);c.setState({});}}}
    finally{pending=false;if(!disposed && form)c.setState({productionContactBusy:false});}
  }
  const recover=()=>reading || (reading=refresh().catch(()=>{}).finally(()=>{reading=null;}));
  async function afterWrite(message:string){try{if(reading)await reading;await refresh();if(!disposed)c.toast(message);}catch(error){if(!disposed){failure=errorMessage(error);c.setState({});c.toast(message+'. Refresh failed; reload to see the latest contacts.');}}}
  c.openAddContact=()=>writable()?c.setState({productionContactForm:{name:'',email:'',company:'',location:'',status:'Pending',consent_confirmed:false},productionContactError:''}):denied();
  c.openContactImport=()=>writable()?c.setState({productionImport:{id:crypto.randomUUID(),rows:[],filename:'',consent_confirmed:false},productionContactError:''}):denied();
  c.submitContact=()=>run(async()=>{
    const form=c.state.productionContactForm;if(!form)return;
    await performAction('/account/data/contacts',form);
    if(disposed)return;c.setState({productionContactForm:null,ctQ:'',ctTab:'all',ctPage:0});await afterWrite('Contact saved');
  },true);
  c.readContactCsv=async(file:File)=>{
    const sequence=++upload,id=c.state.productionImport?.id;
    try{if(file.size>1048576)throw new Error('The CSV must be no larger than 1 MB.');const rows=parseContactCsv(await file.text());if(!disposed && sequence===upload && c.state.productionImport?.id===id)c.setState({productionImport:{id,rows,filename:file.name,consent_confirmed:false},productionContactError:''});}
    catch(error){if(!disposed && sequence===upload && c.state.productionImport?.id===id)c.setState({productionImport:{id,rows:[],filename:'',consent_confirmed:false},productionContactError:errorMessage(error)});}
  };
  c.submitContactImport=()=>run(async()=>{
    const form=c.state.productionImport;if(!form?.rows?.length)return;
    const result=await performAction('/account/data/contacts/import',{contacts:form.rows.map((row:any)=>({...row,consent_confirmed:form.consent_confirmed}))});
    if(disposed)return;c.setState({productionImport:null,ctQ:'',ctTab:'all',ctPage:0});await afterWrite(`Imported ${result.imported} contacts`);
  },true);
  const bulk=(action:string,ids:string[])=>void run(async()=>{if(!ids.length)return;if(ids.length>200)throw new Error('Select up to 200 contacts at a time.');await performAction('/account/data/contacts/bulk',{action,ids});if(disposed)return;c.setState({ctSel:{},ctOpen:null});await afterWrite(action==='delete'?'Contacts deleted. Existing suppressions are retained.':'Contacts unsubscribed');});
  c.contactsVals=()=>{
    const values=original();
    const metrics=[String(stats.total),`${(stats.total?stats.subscribed/stats.total*100:0).toFixed(1)}%`,String(stats.new_month),String(stats.unsubscribed)];
    values.ctKpis=values.ctKpis.map((row:any,index:number)=>({...row,value:failure?'—':metrics[index],delta:'',period:failure || (!loaded?'Loading contacts…':index===2?'Current calendar month':index===1?'Of all contacts':'Current workspace')}));
    const counts:Record<string,number>={All:stats.total,Subscribed:stats.subscribed,Unsubscribed:stats.unsubscribed,Bounced:stats.bounced};
    values.ctTabs=values.ctTabs.map((row:any)=>({...row,count:counts[row.label] ?? row.count}));
    values.ctRows=values.ctRows.map((row:any)=>({...row,engLabel:'Not measured',bars:[],lastFmt:new Date(row.updated_at).toLocaleDateString()}));
    values.ctRangeText=failure || `${values.ctRangeText}${stats.total>c.state.contacts.length?` loaded (${stats.total} total)` : ''}`;
    if(next!==null){const previous=values.ctNext;values.ctNext=()=>{const max=Math.ceil(c.state.contacts.length/10)-1;if(c.state.ctPage>=max)void refresh(true).then(()=>{if(!disposed)c.setState({ctPage:max+1});}).catch(()=>{});else previous();};values.ctNextStyle=values.ctNextStyle.replace('cursor:default','cursor:pointer');}
    const selected=Object.keys(c.state.ctSel).filter(id=>c.state.ctSel[id]);
    values.ctBulkUnsub=()=>bulk('unsubscribe',selected);
    values.ctBulkDelete=()=>{if(window.confirm(`Delete ${selected.length} contacts? Suppressions will be retained.`))bulk('delete',selected);};
    values.ctBulkList=()=>c.openListAssignment?.();
    values.ctBulkExport=()=>c.toast('Contact exports require a purpose/consent review. No export was created.');
    values.ctSendEmail=()=>writable()?location.assign('/email-builder'):denied();
    values.ctToggleSub=()=>{if(!writable())return denied();const contact=c.state.contacts.find((row:any)=>row.id===c.state.ctOpen);if(contact?.status==='Subscribed')bulk('unsubscribe',[contact.id]);else c.toast('Re-subscription requires verified consent and a suppression review. No subscription was changed.');};
    if(!writable()){values.ctHasSel=false;values.ctSubLabel='Read-only access';}
    if(values.hasCt){const contact=c.state.contacts.find((row:any)=>row.id===c.state.ctOpen);if(contact){values.ct.attrs=values.ct.attrs.map((row:any)=>row.k==='Contact ID'?{...row,v:contact.id}:row.k==='Engagement'?{...row,v:'Not measured'}:row);values.ct.activity=[];values.ct.consent=values.ct.consent.slice(0,1).map((row:any)=>({...row,v:contact.status==='Subscribed'?`Consent confirmed ${new Date(contact.consent_confirmed_at).toLocaleString()}`:contact.status}));}}
    values.impPick=c.openContactImport;values.impGo=c.openContactImport;
    return values;
  };
  return {refresh:()=>c.state.view==='contacts'?recover():Promise.resolve(),mount(){if(c.state.view==='contacts')void recover();},changed(previous:Record<string,any>){if(previous.view!=='contacts' && c.state.view==='contacts')void recover();},dispose(){disposed=true;readSequence++;}};
}
