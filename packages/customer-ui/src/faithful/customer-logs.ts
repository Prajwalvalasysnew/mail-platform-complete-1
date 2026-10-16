import type {DesignState} from './runtime';
import {getResource} from './store';
import {errorMessage} from './Login';
import {readFeedback} from './read-feedback';
type Controller=DesignState & Record<string,any>;
const labels:Record<string,string>={queued:'Queued',sent:'Sent',delivered:'Delivered',soft_bounce:'Soft bounce',hard_bounce:'Hard bounce',complaint:'Complaint',opened:'Opened',clicked:'Clicked',unsubscribed:'Unsubscribed',failed:'Failed'};
export function installCustomerLogs(c:Controller){
  const original=c.logsVals.bind(c);
  let disposed=false,pending=false,cursor:number|null=null,failure='',loaded=false;
  let records:any[]=[];
  c.props.textOverrides={...c.props.textOverrides,'Kept 30 days · stream to your warehouse with webhooks':'Shows up to 7 days of available message events.'};
  const redact=(text:string)=>c.state.lgMask?String(text || '').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,email=>c.mask(email,true)).replace(/\+?\d[\d ()-]{7,}\d/g,'••••••••'):text;
  // Prevent the reference render function from starting its simulated stream.
  c._lgT=-1;c.lgDiag=()=>null;
  for(const [type,label] of Object.entries(labels)){
    const tone=type==='hard_bounce' || type==='failed'?c.LGE.bounced:type==='soft_bounce'?c.LGE.deferred:type==='complaint'?c.LGE.complained:c.LGE[type] || c.LGE.processed;
    c.LGE[type]=[label,tone[1],tone[2]];
  }
  function model(event:any){
    const payload=event.payload || {};
    const response=payload.response ?? payload.reason ?? payload.error ?? '';
    return {key:String(event.event_id),type:event.event_type,t:new Date(event.occurred_at),raw:event,resp:typeof response==='string'?response:JSON.stringify(response),code:String(payload.code || ''),
      m:{id:event.message_id,chan:'email',kind:'api',src:'Message service',srcLabel:'Email',to:event.to_address || '',from:event.from_address || '',subject:event.subject || '(no subject)',ip:'—',t:new Date(event.queued_at)}};
  }
  async function refresh(append=false){
    if(pending || disposed || append && cursor===null)return;
    pending=true;
    try{
      const response=await getResource(`/account/data/messages/activity?days=7&limit=200${append?`&before=${cursor}`:''}`,true);
      if(disposed)return;
      const next=response.events.filter((event:any)=>labels[event.event_type]).map(model);
      records=append?[...new Map([...records,...next].map(event=>[event.key,event])).values()]:next;
      cursor=response.next_cursor ?? null;loaded=true;failure='';
      readFeedback(c,'logs');
      c._lg={...c._lg,all:records,byMsg:null};
      c.setState(append?{lgLimit:(c.state.lgLimit || 100)+200}:{});
    }catch(error){if(!disposed){failure=errorMessage(error);readFeedback(c,'logs',error);c.setState({});}}
    finally{pending=false;}
  }
  c.logsVals=()=>{
    const values=original();if(c.state.view!=='logs')return values;
    const milliseconds:Record<string,number>={'15m':900000,'1h':3600000,'24h':86400000,'7d':604800000};
    const windowRecords=records.filter(event=>Date.now()-event.t.getTime()<milliseconds[c.state.lgWin || '24h'] && (c.state.lgLive!==false || event.t.getTime()<=(c.state.lgFreeze || Date.now())));
    const allChip=values.lgChips[0];
    values.lgChips=[allChip,...Object.entries(labels).map(([type,label])=>{
      const on=c.state.lgF===type;
      return {...allChip,label,count:c.state.lgQ?'—':String(windowRecords.filter(event=>event.type===type).length),onClick:()=>c.setState({lgF:type,lgLimit:100}),
        dot:`display:block;width:6px;height:6px;border-radius:50%;background:${c.LGE[type][1]};`,
        style:`display:flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:500;${on?'border:1px solid oklch(0.24 0.015 260);background:oklch(0.24 0.015 260);color:#fff;':'border:1px solid oklch(0.91 0.004 250);background:#fff;color:oklch(0.30 0.015 260);'}`,
        countStyle:`font-size:11.5px;font-weight:500;font-variant-numeric:tabular-nums;color:${on?'oklch(0.85 0.01 250)':'oklch(0.58 0.010 260)'};`};
    })];
    values.lgStats=values.lgStats.map((metric:any,index:number)=>index>0 && index<4?{...metric,value:'—',sub:'Rates are not calculated from a partial activity feed.',onClick:()=>c.go('analytics')}:index===4?{...metric,label:'Failures',value:String(records.filter(event=>event.type==='failed').length),sub:'Failed email events in the loaded feed',onClick:()=>c.setState({lgF:'failed'})}:metric);
    values.lgSrcs=values.lgSrcs.filter((source:any)=>source.label==='All sources');values.lgSrcLabel='All sources';
    values.lgRows=values.lgRows.map((row:any)=>({...row,subject:redact(row.subject),resp:redact(row.resp)}));
    values.lgExport=()=>{
      // Export the rows actually displayed, not an implied complete dataset.
      // Spreadsheet formula prefixes are neutralized before CSV quoting.
      const escape=(value:unknown)=>{let text=String(value ?? '');if(/^[\s\u0000-\u001f]*[=+@-]/.test(text))text="'"+text;return `"${text.replaceAll('"','""')}"`;};
      const rows=[['Timestamp','Event','Recipient','Subject','Source','Response'],...values.lgRows.map((row:any)=>[row.full,row.ev,row.to,row.subject,row.source,row.resp])];
      c.dl('visible-message-events.csv',rows.map(row=>row.map(escape).join(',')).join('\n'));
      c.toast(`Exported ${values.lgRows.length} visible events`);
    };
    const more=values.lgMore;
    values.lgCanMore=values.lgCanMore || cursor!==null;
    values.lgMore=()=>{if(values.lgRows.length<records.length && values.lgCanMore && !cursor)more();else void refresh(true);};
    values.lgFoot=failure || (!loaded?'Loading message activity…':`${values.lgRows.length} shown · ${records.length} loaded${cursor?' · more available':''} · ${c.state.lgLive===false?'paused':'refreshes every 15 seconds'}`);
    if(values.lgHasDetail){
      const selected=records.find(event=>event.key===c.state.lgOpen);
      if(selected){
        const event=selected.raw,mask=!!c.state.lgMask;
        values.lgD.hasDiag=false;
        values.lgD.subject=redact(values.lgD.subject);
        values.lgD.timeline=values.lgD.timeline.map((entry:any)=>({...entry,detail:redact(entry.detail)}));
        values.lgD.headers='Message headers are not included in the activity feed.';
        values.lgD.json=JSON.stringify({...event,subject:redact(event.subject),to_address:c.mask(event.to_address,mask),from_address:c.mask(event.from_address,mask),payload:mask?'Hidden while Mask PII is enabled':event.payload},null,2);
        values.lgD.actions=values.lgD.actions.filter((action:any)=>action.label==='Copy message ID');
        values.lgD.facts=values.lgD.facts.filter((fact:any)=>fact.k!=='Sending IP');
      }
    }
    return values;
  };
  let timer:ReturnType<typeof setInterval> | undefined;
  return {refresh:()=>c.state.view==='logs'?refresh():Promise.resolve(),mount(){timer=setInterval(()=>{if(c.state.view==='logs' && c.state.lgLive!==false)void refresh();},15000);if(c.state.view==='logs')void refresh();},changed(previous:Record<string,any>){if(c.state.view==='logs' && (previous.view!=='logs' || previous.lgLive===false && c.state.lgLive!==false))void refresh();},dispose(){disposed=true;clearInterval(timer);}};
}
