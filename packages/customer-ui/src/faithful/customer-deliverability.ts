import type {DesignState} from './runtime';
import {getResource,performAction,store} from './store';
import {errorMessage} from './Login';
import {readFeedback} from './read-feedback';
type Controller=DesignState & Record<string,any>;
export function installCustomerDeliverability(c:Controller){
 const original=c.deliverabilityVals.bind(c);let disposed=false,busy=false,data:any=null;
 const permitted=()=>['owner','admin','developer'].includes(store.getState().session.identity?.current_role || '');
 async function refresh(){if(!permitted())return;try{const [domains,summary,sources,reporting]=await Promise.all([getResource('/account/domains',true),getResource('/account/data/dmarc/summary',true),getResource('/account/data/dmarc/sources',true),getResource('/account/data/dmarc/reporting-address',true)]);if(disposed)return;data={domains:domains.domains,summary,sources:sources.sources,reporting};readFeedback(c,'deliverability');c.setState({});}catch(error){if(!disposed)readFeedback(c,'deliverability',error);}}
 c.dvRecheck=()=>void(async()=>{if(busy || !permitted())return;busy=true;c.setState({dvChecking:true});try{const domains=await getResource('/account/domains',true);if(!domains.domains.length)throw new Error('Add a sending domain in Settings first.');for(const domain of domains.domains)await performAction(`/account/domains/${domain.id}/verify`);await refresh();if(!disposed)c.toast('DNS checks completed. Review each domain status.');}catch(error){if(!disposed)c.toast(errorMessage(error));}finally{busy=false;if(!disposed)c.setState({dvChecking:false});}})();
 c.deliverabilityVals=()=>{
  const values=original();if(c.state.view!=='deliverability')return values;const {R,card,btn,tabs}=c.ck();
  values.dvScore='—';values.dvRingDash='0 300';values.dvStatus='Measured data only';values.dvHeadline='Authentication and DMARC monitoring';values.dvSub='DNS ownership and aggregate reports do not measure inbox placement. No synthetic reputation score is shown.';const domains=data?.domains || [],mark=(state:'ok'|'bad'|'na')=>`display:flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;flex-shrink:0;font-size:10px;font-weight:700;color:#fff;background:${state==='ok'?'oklch(0.58 0.14 155)':state==='bad'?'oklch(0.60 0.16 60)':'oklch(0.78 0.006 260)'};`;
  const share=(key:string)=>domains.filter((d:any)=>d[key]).length;
  // Rules Gmail, Yahoo and Microsoft apply to bulk senders, checked against this workspace's real DNS state.
  const reqs:[string,string,'ok'|'bad'|'na'][]=data?[
   ['SPF on sending domains',`${share('spf_verified')} of ${domains.length}`,domains.length && share('spf_verified')===domains.length?'ok':'bad'],
   ['DKIM signing',`${share('dkim_verified')} of ${domains.length}`,domains.length && share('dkim_verified')===domains.length?'ok':'bad'],
   ['DMARC record published',`${share('dmarc_verified')} of ${domains.length}`,domains.length && share('dmarc_verified')===domains.length?'ok':'bad'],
   ['One-click unsubscribe','Added to every email','ok'],
   ['Spam complaints under 0.3%','Needs feedback-loop data','na'],
  ]:[];
  values.dvReqs=reqs.map(r=>({label:r[0],val:r[1],mark:r[2]==='ok'?'✓':r[2]==='bad'?'!':'–',dot:mark(r[2])}));
  values.dvReqCount=data?`${reqs.filter(r=>r[2]==='ok').length} of ${reqs.length} met`:'Loading…';values.dvRingColor='transparent';values.dvHasAlert=false;values.hasIndPick=false;
  values.dvKpis=[{label:'Sending domains',value:data?String(data.domains.length):'—',sub:'Current workspace'},{label:'Verified domains',value:data?String(data.domains.filter((d:any)=>d.verified_at).length):'—',sub:'DNS verification'},{label:'DMARC reports',value:data?String(data.summary.reports):'—',sub:'Last 30 days'},{label:'DMARC alignment',value:data?.summary.total_messages?`${(data.summary.pass_rate*100).toFixed(1)}%`:'—',sub:'No percentage without reported messages'}].map(metric=>({...metric,delta:'',period:metric.sub,subStyle:'color:#68707d'}));
  values.cardTabs=tabs([['overview','Overview'],['auth','Authentication'],['sources','DMARC sources']],c.state.dvTab || 'overview',(dvTab:string)=>c.setState({dvTab}));
  values.cards=!permitted()?[card({title:'Restricted',rows:[R.text('Domain access','Your role does not allow domain monitoring.',[])]})]:[card({title:'Sending domains',desc:data?`${data.domains.length} domain${data.domains.length===1?'':'s'}`:'Loading domain data…',table:{cols:[['Domain'],['SPF'],['DKIM'],['DMARC']],rows:(data?.domains || []).map((domain:any)=>({cells:[domain.domain,domain.spf_verified?'Verified':'Not verified',domain.dkim_verified?'Verified':'Not verified',domain.dmarc_verified?'Verified':'Not verified'],acts:[btn('DNS settings',()=>location.assign('/domains'))]}))}}),card({title:'DMARC aggregate reporting',rows:[R.text('Reporting address',data?.reporting.rua_address || 'Not loaded',[]),R.text('Suggested monitoring record',data?.reporting.dns_hint || 'Not loaded',[]),R.text('Report volume',data?`${data.summary.total_messages} messages reported over ${data.summary.window_days} days`:'No reports loaded',[])]}),card({title:'DMARC sending sources',table:{cols:[['IP address'],['Messages'],['Aligned'],['Possible spoofing']],rows:(data?.sources || []).map((source:any)=>({cells:[source.source_ip,String(source.messages),String(source.aligned),source.likely_spoof?'Review':'Not indicated']}))}})];
  if(permitted() && c.state.dvTab==='auth')values.cards=values.cards.slice(0,1);
  if(permitted() && c.state.dvTab==='sources')values.cards=values.cards.slice(2);
  values.dvStatusPill=c.ck().pill('neutral');values.dvReqPill=c.ck().pill('neutral');
  values.dvRunTest=()=>c.toast('Inbox-placement testing needs a configured seed-mailbox provider. No test was sent.');values.dvTestLabel='Placement not configured';values.dvRecheck=c.dvRecheck;values.dvCopyDmarc=()=>data && c.copy(data.reporting.dns_hint,'DMARC monitoring record');return values;
 };
 return {mount(){if(c.state.view==='deliverability')void refresh();},refresh:()=>c.state.view==='deliverability'?refresh():Promise.resolve(),changed(previous:any){if(previous.view!==c.state.view && c.state.view==='deliverability')void refresh();},dispose(){disposed=true;}};
}
