import type { DesignState } from './runtime';
import { getResource, performAction } from './store';
import { errorMessage } from './Login';
import {readFeedback} from './read-feedback';

type Controller=DesignState & Record<string,any>;
const number=(value:unknown)=>Number(value || 0).toLocaleString();
const percent=(value:unknown)=>`${(Number(value || 0)*100).toFixed(1)}%`;
function navigate(path:string){location.assign(path);}
function line(values:number[],width:number,height:number,scale?:number){
  if(!values.length)return '';
  const max=scale || Math.max(1,...values);
  return values.map((value,i)=>`${i?'L':'M'}${values.length===1?0:i/(values.length-1)*width},${height-value/max*(height-10)}`).join(' ');
}

export function installCustomerData(c:Controller){
  let disposed=false,analyticsSequence=0;
  const originalHome=c.homeVals.bind(c),originalAnalytics=c.analyticsVals.bind(c),originalMessages=c.messagesVals.bind(c),originalTemplates=c.templatesVals.bind(c);
  const messageDetails=new Map<string,any>();
  const pendingDetails=new Set<string>();
  let summary:any=null,series:any[]=[],telemetryError='',loaded=false;
  const active=()=>!disposed;
  async function refreshProfile(){
    try{
    const result=await getResource('/account/data/profile',true);
    if(!active())return;
    const customer=result.customer;
    c.props.textOverrides={...c.props.textOverrides,'Acme Inc':customer.name || 'Workspace','Pro workspace':`${customer.tier[0].toUpperCase()+customer.tier.slice(1)} workspace`};
    c.S_DEF={...c.S_DEF,wsName:customer.name || '',legal:'',address:customer.physical_address || '',fromName:customer.name || '',fromEmail:'',replyTo:''};
    // Do not replace a settings draft while an automatic refresh is in flight.
    c.setState({sSaved:{...c.S_DEF},productionProfile:customer});readFeedback(c,'profile');
    }catch(error){if(active())readFeedback(c,'profile',error);throw error;}
  }
  async function run(action:()=>Promise<any>,success?:(result:any)=>void){
    try{const result=await action();if(active())success?.(result);return result;}
    catch(error){if(active())c.toast(errorMessage(error));return null;}
  }
  async function refreshAnalytics(){
    const sequence=++analyticsSequence;
    const selected=c.state.view==='analytics'?(c.state.anRange || '30d'):c.state.range;
    const period=selected==='24h'?'24h':selected==='7d'?'7d':'30d';
    try{
      const [stats,points]=await Promise.all([getResource(`/account/data/analytics/summary?period=${period}`,true),getResource(`/account/data/analytics/timeseries?period=${period==='24h'?'7d':period}&granularity=${period==='24h'?'hour':'day'}`,true)]);
      if(disposed || sequence!==analyticsSequence)return;
      if(!stats || !Array.isArray(points?.series))throw new Error('The analytics response was incomplete. Please refresh.');
      summary=stats;series=points.series.filter((p:any)=>period!=='24h' || Date.now()-new Date(p.date).getTime()<86400000);loaded=true;telemetryError='';readFeedback(c,'analytics');c.setState({});
    }catch(error){if(active() && sequence===analyticsSequence){telemetryError=errorMessage(error);readFeedback(c,'analytics',error);c.setState({});}}
  }
  async function refreshTemplates(){
    try{
    const result=await getResource('/account/data/templates',true);
    if(active()){c.setState({tpls:result.templates.map((row:any)=>({...row,type:'Transactional',edited:new Date(row.updated_at),preheader:'',blocks:[{id:`${row.id}-heading`,t:'heading',text:row.subject}]}))});readFeedback(c,'templates');}
    }catch(error){if(active())readFeedback(c,'templates',error);throw error;}
  }
  async function loadMessage(id:string){
    if(pendingDetails.has(id))return;
    pendingDetails.add(id);
    try{const result=await getResource(`/account/data/messages/${encodeURIComponent(id)}`,true);if(active()){messageDetails.set(id,result);c.setState({});}}
    catch(error){if(active()){messageDetails.set(id,{error:errorMessage(error)});c.setState({});}}
    finally{pendingDetails.delete(id);}
  }
  c.homeVals=()=>{
    const values=originalHome();
    if(c.state.view!=='home')return values;
    const metric=[number(summary?.sent),percent(summary?.delivery_rate),percent(summary?.open_rate),percent(summary?.click_rate)];
    values.kpis=values.kpis.map((row:any,index:number)=>({...row,value:loaded?metric[index]:'—',delta:'',period:telemetryError || 'Current workspace'}));
    values.rangeText=telemetryError || (loaded?'Live message events':'Loading message events…');
    values.chartSub=loaded?`${number(summary?.delivered)} delivered`:'No delivery data available';
    const maximum=Math.max(1,...series.flatMap(p=>[p.delivered,p.opened]));
    values.lineDel=line(series.map(p=>p.delivered),1000,220,maximum);values.lineOpen=line(series.map(p=>p.opened),1000,220,maximum);
    values.areaDel=values.lineDel?values.lineDel+' L1000 220 L0 220 Z':'';
    values.yTicks=series.length?[number(maximum),number(Math.round(maximum*2/3)),number(Math.round(maximum/3)),'0']:[];values.xTicks=series.length?[series[0].date.slice(0,10),series.at(-1).date.slice(0,10)]:[];
    values.hoverCols=[];values.hasHover=false;values.scoreTicks=[];
    values.dlvRows=values.dlvRows.map((row:any)=>({...row,value:loaded && row.label==='Bounce rate'?percent(summary.sent?summary.bounced/summary.sent:0):loaded && row.label==='Spam complaints'?percent(summary.sent?summary.complained/summary.sent:0):'—',sub:'No measurement',tag:'No data',label:row.label,pill:'',bar:'width:0;',dot:'display:block;width:7px;height:7px;border-radius:50%;background:oklch(0.70 0.01 260);'}));
    values.showRecs=false;values.recs=[];values.campRows=[];values.campEmpty=true;values.campCount=0;
    return values;
  };
  c.analyticsVals=()=>{
    const values=originalAnalytics();
    if(c.state.view!=='analytics')return values;
    const rates=[summary?.delivery_rate,summary?.open_rate,summary?.click_rate,summary?.opened?summary.clicked/summary.opened:0,summary?.delivered?summary.unsubscribed/summary.delivered:0,null];
    values.anKpis=values.anKpis.map((row:any,index:number)=>({...row,label:index===1?'Recorded opens':row.label,tip:'Recorded workspace events. Repeat events may be counted; no estimated benchmark is applied.',value:!loaded || rates[index]===null?'—':percent(rates[index]),hasDelta:false,line:'',area:'',barStyle:'width:0;',benchStyle:'display:none;',vs:'',benchTxt:'No comparison data'}));
    values.anInsights=[];values.anPrev='';values.anArea='';values.anBenchY='-100';values.anGrid=[];values.anYLabels=[];values.anXLabels=[];
    const key:Record<string,string>={delivered:'delivered',open:'opened',click:'clicked'};
    values.anLine=line(series.map(p=>p[key[c.state.anMetric || 'open']] || 0),800,200);
    values.anTrendSub=telemetryError || 'Live message events · no estimated benchmarks';
    values.anTrendTitle='Message events over time';values.anHasHover=false;values.anHits=[];
    const fields=['sent','delivered','opened','clicked'];values.anFunnel=values.anFunnel.map((row:any,index:number)=>({...row,value:loaded && fields[index]?number(summary[fields[index]]):'—',pct:'',step:'',barStyle:'width:0;'}));
    values.anFunnelSub='Attribution is not configured';values.anRows=[];values.anHeat=[];values.anProviders=[];values.anLinks=[];values.anPeak='—';
    values.anRanges=values.anRanges.filter((row:any)=>row.label!=='90 days');
    values.anChans=values.anChans.filter((row:any)=>row.label==='Email');
    values.anExport=()=>c.dl('analytics.csv',[['Date','Sent','Delivered','Opened','Clicked'],...series.map(p=>[p.date,p.sent,p.delivered,p.opened,p.clicked])].map(row=>row.join(',')).join('\n'));
    return values;
  };
  c.messagesVals=()=>{
    const values=originalMessages();
    values.mStats=values.mStats.map((row:any)=>({...row,label:row.label==='Deferred'?'Pending':row.label==='Bounced'?'Failures':row.label,sub:row.label==='All messages'?'Most recent 100 messages':row.label==='Deferred'?'Queued, held, sending or deferred':row.label==='Bounced'?'Failed, suppressed or bounced':row.sub?.includes('NaN')?'0% of sent':row.sub}));
    values.mRows=values.mRows.map((row:any)=>({...row,status:row.actualStatus,opens:row.opens?'Yes':'—',clicks:row.clicks?'Yes':'—',onOpen:()=>{c.setState({mOpen:row.id,mTab:'ov'});void loadMessage(row.id);}}));
    if(c.state.mOpen){
      const detail=messageDetails.get(c.state.mOpen);
      values.msg={...values.msg,status:c.state.msgs.find((row:any)=>row.id===c.state.mOpen)?.actualStatus,events:[],details:[],headers:[],json:'',hasIssue:false,issueTitle:'',issueBody:'',smtp:''};
      if(detail?.message){
        const m=detail.message;
        values.msg.details=[['Message ID',m.message_id],['From',m.from_address],['To',m.to_address],['Status',m.status],['Queued',m.queued_at]].map(([k,v])=>({k,v:v || '—',copy:k==='Message ID',onCopy:()=>c.copy(String(v),k)}));
        values.msg.events=detail.events.map((event:any)=>({label:event.event_type,detail:event.payload?.response || event.payload?.reason || '',time:new Date(event.occurred_at).toLocaleString(),dot:'display:block;width:9px;height:9px;border-radius:50%;background:oklch(0.58 0.14 155);'}));
        values.msg.json=JSON.stringify(detail,null,2);
      }else values.msg.details=[{k:'Status',v:detail?.error || 'Loading message…'}];
    }
    return values;
  };
  c.templatesVals=()=>{
    const values=originalTemplates();
    const rows=c.state.tpls.filter((t:any)=>(c.state.tTab==='all' || t.type===c.state.tTab) && (!c.state.tQ || t.name.toLowerCase().includes(c.state.tQ.toLowerCase())));
    values.tNew=()=>navigate('/email-builder');
    values.tCards=values.tCards.map((card:any,index:number)=>{
      const template=rows[index];if(!template)return card;
      const open=()=>navigate(`/email-builder?id=${encodeURIComponent(template.id)}`);
      return {...card,onOpen:open,menu:card.menu.map((item:any)=>({...item,onClick:item.label==='Edit'?open:item.label==='Delete'?()=>void run(()=>performAction(`/account/data/templates/${encodeURIComponent(template.id)}`,undefined,'DELETE'),()=>{c.setState({tMenu:null});void run(refreshTemplates);}):()=>void run(async()=>{
        const document=await getResource(`/account/data/templates/${encodeURIComponent(template.id)}`,true);
        await performAction('/account/data/templates',{name:`${document.name.slice(0,70)} (copy ${Date.now()})`,subject:document.subject,html_body:document.html_body || undefined,text_body:document.text_body || undefined,editor_document:document.editor_document});
        await refreshTemplates();c.setState({tMenu:null});
      })}))};
    });
    return values;
  };
  return {
    refresh(){return Promise.all([run(refreshProfile),...(['home','analytics'].includes(c.state.view)?[refreshAnalytics()]:[]),...(c.state.view==='templates'?[run(refreshTemplates)]:[])]);},
    mount(){if(['home','analytics'].includes(c.state.view))void refreshAnalytics();void run(refreshProfile);if(c.state.view==='templates')void run(refreshTemplates);},
    changed(previous:Record<string,any>){
      if(previous.view!==c.state.view && c.state.view==='templates')void run(refreshTemplates);
      if(['home','analytics'].includes(c.state.view) && (previous.range!==c.state.range || previous.anRange!==c.state.anRange || previous.view!==c.state.view))void refreshAnalytics();
    },
    dispose(){disposed=true;},
  };
}
