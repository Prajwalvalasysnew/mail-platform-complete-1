import type { DesignState, DesignValues } from './runtime';
import { errorMessage } from './Login';
import { getResource, identityReceived, navigated, performAction, sidebarChanged, signedOut, store, tokenReceived } from './store';
import { installCustomerData } from './customer-data';
import { installCustomerSettings } from './customer-settings';
import { messageModel } from './message-model';
import { installCustomerLogs } from './customer-logs';
import {installCustomerContacts} from './customer-contacts';
import {CustomerOverlays} from './CustomerOverlays';
import {readFeedback} from './read-feedback';
import {installCustomerAudiences} from './customer-audiences';
import {installCustomerDeliverability} from './customer-deliverability';
import {installCustomerAutomations} from './customer-automations';
import {installCustomerCampaigns} from './customer-campaigns';

type Controller = DesignState & Record<string,any>;
const viewFromPath: Record<string,string> = { '/': 'home', '/api-keys':'apikeys', '/event-logs':'logs', '/domains':'settings', '/team':'settings', '/billing':'settings' };
const scopeMap: Record<string,string | undefined> = { mail:'send', messages:'messages', templates:'templates', automations:'workflows', webhooks:'webhooks', suppressions:'suppressions', stats:'messages' };
function navigate(path: string) { history.pushState({},'',path); window.dispatchEvent(new PopStateEvent('popstate')); }
function date(value?: string) { return value ? new Date(value).getTime() : null; }

// Production adapters replace fixture data and simulated writes while leaving
// the reference view tree, style values and event contracts intact.
export function prepareCustomer(base: DesignState, registration = false) {
  const c = base as Controller;
  const identity=store.getState().session.identity;
  const displayName=identity?.user.name || identity?.user.email || 'Account';
  c.props.textOverrides={
    'Acme Inc':identity?.memberships.find(m=>m.customer_id===identity.current_customer_id)?.org_name || 'Workspace',
    'Pro workspace':'Workspace','Sarah Chen':displayName,'Workspace owner':identity?.current_role || 'Member',
    'sarah@acme.com':identity?.user.email || '', 'SC':displayName.split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase(), '94':'—','Healthy':'Not measured','+3 this week':'No score available',
    'content comes in a later step':'is not connected yet',
    'The shell, onboarding and Home dashboard are built. The remaining pages follow one at a time.':'This feature is still being integrated. No sample customer data or simulated actions are available here.',
    'We use this to set sensible defaults — IP pools, tracking and unsubscribe handling. You can change any of it later.':'Your company name is saved as your workspace name. The remaining preferences are not applied to sending policies yet.',
    'Mail from a verified domain lands in the inbox, not spam. We recommend a subdomain like':'Verify ownership and authenticate your mail. Verification does not guarantee inbox placement. We recommend a subdomain like',
  };
  const originalVals = c.renderVals.bind(c);
  const originalGo = c.go;
  const originalMount = c.componentDidMount.bind(c);
  const originalSetState = c.setState.bind(c);
  let disposed = false;
  let data: ReturnType<typeof installCustomerData> | undefined;
  let settings: ReturnType<typeof installCustomerSettings> | undefined;
  let logs: ReturnType<typeof installCustomerLogs> | undefined;
  let contacts:ReturnType<typeof installCustomerContacts> | undefined;
  let audiences:ReturnType<typeof installCustomerAudiences>|undefined;
  let deliverability:ReturnType<typeof installCustomerDeliverability>|undefined;
  let automations:ReturnType<typeof installCustomerAutomations>|undefined;
  let campaigns:ReturnType<typeof installCustomerCampaigns>|undefined;
  c.props.overlay=CustomerOverlays;
  const existingOnboarding=!registration && location.pathname==='/onboarding';
  c.state = {...c.state,onboarding:registration || existingOnboarding,obStep:existingOnboarding?1:c.state.obStep,view:existingOnboarding?'home':viewFromPath[location.pathname] || location.pathname.slice(1) || 'home',
    camps:[],contacts:[],msgs:[],segs:[],lists:[],keys2:[],whEps:[],whDels:[],tpls:[],autos:[],notifs:[],mLive:false,
    sTab:location.pathname==='/domains'?'sending':location.pathname==='/team'?'team':location.pathname==='/billing'?'billing':'general'};
  c.seedCamps = c.seedContacts = c.seedMsgs = c.keySeed = c.seedTpls = c.seedAutos = ()=>[];
  // Never expose the reference's example credential or synthesized DNS values.
  c.apiKey='$VALASYS_API_KEY';
  c.dnsRecs=()=>c.state.productionDomain?.dns_records || [];
  const setOb=c.setOb.bind(c);
  c.setOb=(key:string)=>key!=='domain'?setOb(key):(event:Event)=>c.setState({ob:{...c.state.ob,domain:(event.target as HTMLInputElement).value},productionDomain:null,dnsShown:false,dns:['pending','pending','pending','pending']});
  c.whSeed = ()=>({eps:[],dels:[]});
  c._wfCache = [];
  c._lg={ind:'ecom',all:[],rnd:()=>0,byMsg:null};
  c.lgData=()=>c._lg;
  c.lgTick=()=>{};
  c.setState = (update: DesignValues | ((state:DesignValues)=>DesignValues),callback?:()=>void)=>{
    const previous = c.state;
    originalSetState(update,callback);
    if (previous.view !== c.state.view){store.dispatch(navigated(c.state.view));if(!registration)void refreshSection();}
    if (previous.collapsed !== c.state.collapsed) store.dispatch(sidebarChanged(c.state.collapsed));
    if(!registration){data?.changed(previous);settings?.changed(previous);logs?.changed(previous);contacts?.changed(previous);audiences?.changed(previous);deliverability?.changed(previous);automations?.changed(previous);campaigns?.changed(previous);}
  };
  c.go = (view:string)=>{
    if (view === 'agent') return navigate('/ai-agent');
    originalGo(view);
    const path = view==='home'?'/':view==='apikeys'?'/api-keys':view==='logs'?'/event-logs':`/${view}`;
    history.pushState({},'',path);
  };
  const pop = ()=>{const tab:Record<string,string>={'/domains':'sending','/team':'team','/billing':'billing'};c.setState({view:viewFromPath[location.pathname] || location.pathname.slice(1) || 'home',...(tab[location.pathname]?{sTab:tab[location.pathname]}:{})});};
  let actionPending=false;
  async function run(action:()=>Promise<any>,success?:(value:any)=>void) {
    const writing=![refreshKeys,refreshWebhooks,refreshMessages].includes(action);
    if(writing && actionPending)return null;
    if(writing)actionPending=true;
    try { const value=await action(); if(writing)actionPending=false;if (!disposed) await success?.(value); return value; }
    catch(error) { if (!disposed) c.toast(errorMessage(error)); return null; }
    finally{if(writing)actionPending=false;}
  }
  async function refreshKeys() {
    const data = await getResource('/account/api-keys',true);
    if (disposed) return;
    c.setState({keys2:data.keys.map((key:any)=>({id:key.id,name:key.name,prefix:key.key_prefix || key.prefix || '',env:key.key_type==='test'?'test':'live',preset:'custom',
      scopes:Object.fromEntries(c.K_SCOPES.map((s:any)=>[s[0],key.scopes?.includes(scopeMap[s[0]])?s[3].at(-1):'none'])),ips:key.ip_allowlist || [],created:date(key.created_at),last:date(key.last_used_at),lastIp:'',req24:0,err24:0,by:'Workspace',exp:date(key.expires_at),revoked:date(key.revoked_at)}))});
  }
  async function refreshWebhooks() {
    const data = await getResource('/account/webhooks',true);
    if (!disposed) c.setState({whEps:data.webhooks.map((row:any)=>({id:row.id,url:row.url,events:row.events.map((e:string)=>e.startsWith('email.')?e:`email.${e}`),on:row.enabled,desc:'',created:date(row.created_at),secret:c.state.whEps.find((e:any)=>e.id===row.id)?.secret || '',headers:[],batch:false,failSince:null})),whDels:[]});
  }
  async function refreshMessages() {
    const data=await getResource('/account/data/messages?limit=100',true);
    if(disposed)return;
    c.setState({msgs:data.messages.map(messageModel)});
  }
  async function sectionRead(key:string,action:()=>Promise<void>){
    try{await action();if(!disposed)readFeedback(c,key);}catch(error){if(!disposed)readFeedback(c,key,error);}
  }
  async function refreshSection(){
    const role=store.getState().session.identity?.current_role;
    if(c.state.view==='apikeys' && ['owner','admin','developer'].includes(role || ''))await sectionRead('keys',refreshKeys);
    if(c.state.view==='webhooks' && ['owner','admin'].includes(role || ''))await sectionRead('webhooks',refreshWebhooks);
    if(c.state.view==='messages')await sectionRead('messages',refreshMessages);
  }
  let refreshing:Promise<void>|undefined,lastRefresh=0,queuedReconnect=false;
  c.refreshWorkspace=()=>{
    if(refreshing)return refreshing;
    if(disposed || registration || !navigator.onLine || c.state.productionContactBusy)return Promise.resolve();
    c.setState({productionRefreshing:true});lastRefresh=Date.now();
    refreshing=Promise.all([refreshSection(),data?.refresh(),settings?.refresh(),logs?.refresh(),contacts?.refresh(),audiences?.refresh(),deliverability?.refresh(),automations?.refresh(),campaigns?.refresh()]).then(()=>{}).finally(()=>{refreshing=undefined;if(!disposed){c.setState({productionRefreshing:false});if(queuedReconnect){queuedReconnect=false;void c.refreshWorkspace();}}});
    return refreshing;
  };
  const resume=()=>{if(document.visibilityState==='visible' && Date.now()-lastRefresh>10000)void c.refreshWorkspace();};
  const reconnected=()=>{if(refreshing){queuedReconnect=true;return;}lastRefresh=0;resume();};
  let poll:ReturnType<typeof setInterval> | undefined;
  c.componentDidMount = ()=>{
    window.addEventListener('popstate',pop);
    originalMount(); clearInterval(c._live); clearInterval(c._lgT);
    if (registration) return;
    const me=store.getState().session.identity;
    c.setState({ob:{...c.state.ob,name:me?.user.name || '',email:me?.user.email || '',company:me?.memberships.find(m=>m.customer_id===me.current_customer_id)?.org_name || ''}});
    void refreshSection();
    data?.mount();settings?.mount();logs?.mount();contacts?.mount();audiences?.mount();deliverability?.mount();automations?.mount();campaigns?.mount();
    lastRefresh=Date.now();
    window.addEventListener('focus',resume);window.addEventListener('online',reconnected);document.addEventListener('visibilitychange',resume);
    poll=setInterval(()=>{if(document.visibilityState==='visible' && c.state.view==='messages' && c.state.mLive)void sectionRead('messages',refreshMessages);},15000);
  };
  let domainBusy=false;
  async function prepareDomain(){
    const name=c.state.ob.domain.trim().toLowerCase();
    if(!name)throw new Error('Enter your sending domain first.');
    let domain=c.state.productionDomain;
    if(!domain || domain.domain!==name){
      const existing=await getResource('/account/domains',true);
      const found=existing.domains.find((row:any)=>row.domain===name);
      domain=found?await getResource(`/account/domains/${encodeURIComponent(found.id)}`,true):await performAction('/account/domains',{domain:name});
    }
    if(disposed || c.state.ob.domain.trim().toLowerCase()!==name)return null;
    c.setState({productionDomain:domain,dnsShown:true,dns:Array(Math.max(4,domain.dns_records?.length || 0)).fill(domain.verified_at?'ok':'pending')});
    return domain;
  }
  c.obVerify = ()=>void run(async()=>{
    if(domainBusy)return;
    domainBusy=true;
    c.setState({checking:true});
    try {
      const domain=await prepareDomain();if(!domain)return;
      const result=await performAction(`/account/domains/${encodeURIComponent(domain.id)}/verify`);
      if(disposed || c.state.productionDomain?.id!==domain.id)return;
      const verified=result.status==='verified' || result.verified || result.verified_at;
      c.setState({dns:Array(Math.max(4,domain.dns_records?.length || 0)).fill(verified?'ok':'pending')});
      c.toast(verified?'Domain verified':'Publish the required DNS records, then verify again.');
    } finally { domainBusy=false;if(!disposed)c.setState({checking:false}); }
  });
  c.obSendTest = ()=>c.toast('Verify a sending domain and create an API key before sending.');
  c.dvRecheck = ()=>c.toast('DNS checks require a configured sending domain.');
  c.dvRunTest = ()=>c.toast('Inbox placement testing is not configured for this workspace.');
  const unavailable = ()=>c.toast('This service is not available for this workspace yet.');
  c.aiAsk=()=>c.toast('AI assistance is not connected to a workspace service yet.');
  c.renderVals = ()=>{
    const values=originalVals();
    values.showAiInsight=false;
    values.showChecklist=false;
    values.nav=values.nav.map((section:any)=>({...section,items:section.items.map((item:any)=>({...item,badge:'',hasBadge:false,dot:false}))}));
    if(c.state.view==='home')values.pageTitle=`Good morning, ${displayName.split(' ')[0]}`;
    values.workspaces=identity?.memberships.map(m=>({
      name:m.org_name || m.customer_name || m.customer_id,plan:m.role,initial:(m.org_name || m.customer_name || 'W')[0],
      current:m.customer_id===identity.current_customer_id,
      logoStyle:'display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;background:oklch(0.56 0.20 25);color:#fff;font-size:13px;font-weight:700;',
      onClick:()=>{if(m.customer_id===identity.current_customer_id)return c.setState({wsOpen:false});void run(()=>performAction('/auth/switch-org',{customer_id:m.customer_id}),()=>{store.dispatch({type:'customerApi/resetApiState'});location.assign('/');});},
    })) || [];
    values.profileItems=values.profileItems?.map((item:any)=>item.label==='Restart onboarding'?{...item,onClick:()=>c.setState({profileOpen:false,onboarding:true,obStep:1})}:item);
    values.pageActions=values.pageActions.map((action:any)=>c.state.view==='home' && action.label==='Send email'?{...action,onClick:()=>location.assign('/email-builder')}:action);
    if(c.state.view==='contacts')values.pageActions=values.pageActions.map((action:any)=>({...action,onClick:action.label==='Add contact'?c.openAddContact:c.openContactImport}));
    if(c.state.view==='contacts' && !['owner','admin','developer'].includes(identity?.current_role || ''))values.pageActions=[];
    values.onLogout=()=>void performAction('/auth/logout',{}).catch(()=>{}).finally(()=>{store.dispatch(signedOut());navigate('/login');});
    values.obSso=unavailable;
    values.obBookCall=unavailable;
    values.obGenRecords=()=>void run(async()=>{
      if(domainBusy)return;domainBusy=true;c.setState({checking:true});
      try{await prepareDomain();}finally{domainBusy=false;if(!disposed)c.setState({checking:false});}
    });
    const records=c.state.productionDomain?.dns_records || [];
    values.dnsSummary=`${c.state.dns.every((value:string)=>value==='ok')?records.length:0} of ${records.length} verified`;
    values.apiKeyShown='Create a key in Settings → API keys';
    values.toggleReveal=values.copyKey=()=>c.toast('Create a real API key from the API keys page. Keys are shown only once.');
    values.code='Create an API key and verify your sending domain before using the sending API. Open Email Builder to compose and test a saved email.';
    values.copyCode=()=>c.toast('Use the sending API documentation with your own verified domain and API key.');
    if(c.state.obStep===1){
      values.obNext=()=>void run(async()=>{
        if(c.state.registrationBusy)return;
        if(!c.state.ob.company?.trim())throw new Error('Enter your workspace name.');
        c.setState({registrationBusy:true});
        try{
          await performAction('/account/data/profile',{name:c.state.ob.company.trim()},'PATCH');
          if(!disposed)c.setState({obStep:2});
        }finally{if(!disposed)c.setState({registrationBusy:false});}
      });
    }
    if(existingOnboarding){if(c.state.obStep===4)values.obNext=()=>navigate('/');values.obExit=()=>navigate('/');}
    if (registration) {
      const next=values.obNext;
      values.obNext=()=>{
        if (c.state.obStep !== 0) return next();
        const ob=c.state.ob;
        if (!ob.name.trim() || !ob.email || ob.pw.length<8 || c.state.registrationBusy) return;
        c.setState({registrationBusy:true});
        void run(()=>performAction('/auth/register',{name:ob.name,email:ob.email,password:ob.pw,org_name:ob.company || ob.name}),async result=>{
          store.dispatch(tokenReceived(result));
          store.dispatch(identityReceived(await getResource('/auth/me',true)));
          c.setState({obStep:1,ob:{...c.state.ob,pw:''}});
        }).finally(()=>c.setState({registrationBusy:false}));
      };
      if (c.state.obStep===4) values.obNext=()=>navigate('/');
      values.obExit=()=>navigate('/');
    }
    values.kCreate=()=>{
      const m=c.state.kM;
      if (!m?.name?.trim()) return;
      if (m.id) return unavailable();
      if(m.ips?.trim())return c.toast('IP restrictions are not supported by this API yet.');
      const unsupported=Object.entries(m.scopes || {}).some(([key,value])=>value!=='none' && !scopeMap[key]);
      if(unsupported)return c.toast('Some selected permissions are not supported by this API yet.');
      const scopes=[...new Set(Object.entries(m.scopes || {}).filter(([,v])=>v!=='none').map(([k])=>scopeMap[k]).filter(Boolean))];
      void run(()=>performAction('/account/api-keys',{name:m.name.trim(),scopes,key_type:m.env==='test'?'test':'secret',...(m.exp && m.exp!=='never'?{expires_in_days:Number(m.exp)}:{})}),row=>{ c.setState({kModal:false,kNewSecret:row.api_key,kNewMode:'new'}); void run(refreshKeys); });
    };
    const rotateKey=(id:string)=>{if(c.state.kRotC!==id)return c.setState({kRotC:id,kConfirm:null});void run(()=>performAction(`/account/api-keys/${encodeURIComponent(id)}/rotate`),row=>{c.setState({kRotC:null,kNewSecret:row.api_key,kNewMode:'rotate'});void run(refreshKeys);});};
    const revokeKey=(id:string)=>{if(c.state.kConfirm!==id)return c.setState({kConfirm:id,kRotC:null});void run(()=>performAction(`/account/api-keys/${encodeURIComponent(id)}`,undefined,'DELETE'),()=>{c.setState({kOpen:null,kConfirm:null});void run(refreshKeys);});};
    if (values.kRows) values.kRows=values.kRows.map((row:any)=>{const key=c.state.keys2.find((k:any)=>k.name===row.name);return {...row,
      onRotate:(event:Event)=>{event.stopPropagation();if(key)rotateKey(key.id);},onRevoke:(event:Event)=>{event.stopPropagation();if(key)revokeKey(key.id);}};});
    if(values.kD){values.kD.onRotate=()=>rotateKey(c.state.kOpen);values.kD.onRevoke=()=>revokeKey(c.state.kOpen);}
    const webhook=c.state.whEps.find((e:any)=>e.id===c.state.whSel) || c.state.whEps[0];
    values.whToggle=()=>webhook && void run(()=>performAction(`/account/webhooks/${encodeURIComponent(webhook.id)}`,{enabled:!webhook.on},'PATCH'),()=>void run(refreshWebhooks));
    values.whDelete=()=>{if(!webhook)return;if(c.state.whDelC!==webhook.id)return c.setState({whDelC:webhook.id});void run(()=>performAction(`/account/webhooks/${encodeURIComponent(webhook.id)}`,undefined,'DELETE'),()=>{c.setState({whSel:null,whDelC:null});void run(refreshWebhooks);});};
    values.whCreate=()=>{
      const events=c.WH_EV.filter((g:any)=>c.state.whNewGroups?.includes(g[0])).flatMap((g:any)=>g[1].map((e:any)=>e[0]));
      if(events.some((e:string)=>!e.startsWith('email.')))return c.toast('Only email events are supported by this API.');
      void run(()=>performAction('/account/webhooks',{url:c.state.whUrl,events:events.map((e:string)=>e.slice(6))}),row=>{
        c.setState({whModal:false,whSel:row.id,whUrl:'',whEps:[...c.state.whEps,{id:row.id,url:row.url,secret:row.secret,events:row.events.map((e:string)=>`email.${e}`),on:true,desc:'',headers:[],batch:false,created:date(row.created_at)}]});void run(refreshWebhooks);
      });
    };
    values.whRotate=()=>{if(!webhook)return;if(c.state.whRotC!==webhook.id)return c.setState({whRotC:webhook.id});void run(()=>performAction(`/account/webhooks/${encodeURIComponent(webhook.id)}/rotate-secret`),row=>{c.setState({whRotC:null,whRev:true,whEps:c.state.whEps.map((e:any)=>e.id===row.id?{...e,secret:row.secret}:e)});});};
    values.whSaveUrl=()=>webhook && void run(()=>performAction(`/account/webhooks/${encodeURIComponent(webhook.id)}`,{url:c.state.whEdit?.[webhook.id]},'PATCH'),()=>void run(refreshWebhooks));
    for (const key of ['ctImport','impGo','impFinish','whTest','whRetryAll','whAddHdr','whBatchToggle','sInvite','sAddDomain','sCheckout']) if(typeof values[key]==='function') values[key]=unavailable;
    return values;
  };
  if(!registration){data=installCustomerData(c);settings=installCustomerSettings(c);logs=installCustomerLogs(c);contacts=installCustomerContacts(c);audiences=installCustomerAudiences(c);deliverability=installCustomerDeliverability(c);automations=installCustomerAutomations(c);campaigns=installCustomerCampaigns(c);}
  return ()=>{disposed=true;data?.dispose();settings?.dispose();logs?.dispose();contacts?.dispose();audiences?.dispose();deliverability?.dispose();automations?.dispose();campaigns?.dispose();clearInterval(poll);window.removeEventListener('popstate',pop);window.removeEventListener('focus',resume);window.removeEventListener('online',reconnected);document.removeEventListener('visibilitychange',resume);};
}
