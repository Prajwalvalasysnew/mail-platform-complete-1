import type { DesignState } from './runtime';
import { getResource, performAction, store } from './store';
import { errorMessage } from './Login';
import {readFeedback} from './read-feedback';

type Controller=DesignState & Record<string,any>;
const roles=[['admin','Admin'],['developer','Developer'],['analyst','Analyst'],['billing','Billing']];
const human=(value:string)=>value ? value[0].toUpperCase()+value.slice(1) : 'Not configured';
export function installCustomerSettings(c:Controller){
  const original=c.settingsVals.bind(c);
  let disposed=false,sequence=0,busy=false;
  let members:any[]=[],invites:any[]=[],domains:any[]=[],sessions:any[]=[],billing:any=null,quota:any=null,invoices:any[]=[];
  let failure='',loaded=false;
  const unavailable=()=>c.toast('This setting is not supported by the current service. No changes were saved.');
  async function run(action:()=>Promise<any>){
    if(busy)return;
    busy=true;
    try{await action();}catch(error){if(!disposed)c.toast(errorMessage(error));}
    finally{busy=false;}
  }
  async function refresh(){
    const current=++sequence;loaded=false;failure='';
    try{
      switch(c.state.sTab){
        case 'team':{
          const result=await getResource('/team/members',true);
          const role=store.getState().session.identity?.current_role;
          const pendingInvites=['owner','admin'].includes(role || '')?(await getResource('/team/invites',true)).invites:[];
          if(disposed || current!==sequence)return;members=result.members;invites=pendingInvites;
          break;
        }
        case 'sending':{const result=await getResource('/account/domains',true);if(disposed || current!==sequence)return;domains=result.domains;break;}
        case 'security':{const result=await getResource('/auth/sessions',true);if(disposed || current!==sequence)return;sessions=result.sessions;break;}
        case 'billing':{
          const result=await Promise.all([getResource('/account/billing',true),getResource('/account/data/usage/quota',true),getResource('/account/billing/invoices',true)]);
          if(disposed || current!==sequence)return;
          [billing,quota]=result;invoices=result[2].invoices || [];break;
        }
      }
      if(!disposed && current===sequence){loaded=true;readFeedback(c,'settings');}
    }catch(error){if(!disposed && current===sequence){failure=errorMessage(error);readFeedback(c,'settings',error);}}
    if(!disposed && current===sequence)c.setState({});
  }
  const feedback=()=>failure || (loaded?'No records in this workspace.':'Loading workspace data…');
  c.settingsVals=()=>{
    const values=original();if(c.state.view!=='settings')return values;
    const {card,R,btn}=c.ck();
    const status=(label:string,help:string)=>R.status(label,help,'Not configured','neutral',null,[btn('Details',unavailable)]);
    values.hasIndPick=false;
    const mutate=(action:()=>Promise<any>,message:string)=>void run(async()=>{await action();await refresh();if(!disposed)c.toast(message);});
    if(c.state.sTab==='general'){
      const profile=c.state.productionProfile;
      values.cards=values.cards.map((item:any)=>item.title==='Workspace'?{...item,rows:item.rows.map((row:any)=>['Workspace name','Postal address'].includes(row.label)?row:status(row.label,'Not stored or enforced by this service.'))}:card({title:item.title,rows:[status('Industry preferences','Industry-specific benchmarks are not configured.')]}));
      if(profile)values.cards.push(card({title:'Workspace email verification',rows:[R.status('Email ownership',profile.email,profile.email_verified_at?'Verified':'Verification required',profile.email_verified_at?'good':'warn',null,!profile.email_verified_at && profile.email===store.getState().session.identity?.user.email?[btn('Resend verification',()=>void run(async()=>{await performAction('/auth/resend-verification',{});if(!disposed)c.toast('Verification email requested. Check your inbox.');}))]:[])]}));
      values.sSaveAll=()=>void run(async()=>{
        const draft=c.state.sDraft || c.state.sSaved;
        if(!draft || !draft.wsName?.trim())throw new Error('Enter a workspace name.');
        const address=draft.address?.trim();
        if(address && address.length<5)throw new Error('Enter a complete postal address.');
        await performAction('/account/data/profile',{name:draft.wsName.trim(),physical_address:address || null},'PATCH');
        if(disposed)return;
        // Preserve edits made while the save was in flight.
        c.props.textOverrides={...c.props.textOverrides,'Acme Inc':draft.wsName.trim()};
        c.setState({sSaved:{...draft,wsName:draft.wsName.trim(),address:address || ''},...(c.state.sDraft===draft?{sDraft:null}:{})});
        c.toast('Workspace settings saved');
      });
    }else if(c.state.sTab==='sending'){
      const add=()=>void run(async()=>{
        const domain=c.state.sNewDomain?.trim().toLowerCase();
        if(!domain)throw new Error('Enter your sending domain.');
        const result=await performAction('/account/domains',{domain});
        if(!disposed)c.setState({sNewDomain:'',productionDns:result});
        await refresh();if(!disposed)c.toast('Domain added. Publish its DNS records before verifying.');
      });
      const showDns=(id:string)=>void run(async()=>{const result=await getResource(`/account/domains/${encodeURIComponent(id)}`,true);if(!disposed)c.setState({productionDns:result});});
      values.cards=values.cards.map((item:any)=>{
        if(item.title!=='Sending domains')return {...item,rows:item.rows.map((row:any)=>status(row.label,'Set this explicitly on each email or workflow.')),acts:[],trows:[]};
        return card({title:item.title,desc:failure || (!domains.length?feedback():`${domains.length} sending domains`),
          rows:[R.input('Add a sending domain','Publish the returned DNS records to authenticate your mail.',c.state.sNewDomain || '',(event:Event)=>c.setState({sNewDomain:(event.target as HTMLInputElement).value}),{ph:'mail.yourcompany.com',acts:[btn('Add domain',add,'p')]})],
          table:{cols:[['Domain'],['Purpose'],['Status']],rows:domains.map(domain=>({cells:[{v:domain.domain,mono:true},'Sending',{v:domain.verified_at?'Verified':'Waiting for DNS',tone:domain.verified_at?'good':'warn'}],acts:[btn('DNS records',()=>showDns(domain.id)),btn('Re-check',()=>mutate(async()=>{
            const result=await performAction(`/account/domains/${encodeURIComponent(domain.id)}/verify`);
            if(!result.verified)throw new Error('DNS records are not verified yet. Check their values and try again.');
          },'Domain verified'))]}))}});
      });
      if(c.state.productionDns){const dns=c.state.productionDns;values.cards.push(card({title:`DNS records · ${dns.domain}`,acts:[btn('Close',()=>c.setState({productionDns:null}))],table:{cols:[['Type'],['Host'],['Value']],rows:(dns.dns_records || []).map((record:any)=>({cells:[record.type,{v:record.host,mono:true},{v:record.value,mono:true}],acts:[btn('Copy',()=>c.copy(record.value,'DNS record'))]}))}}));}
      values.sHasDirty=false;
    }else if(c.state.sTab==='team'){
      const self=store.getState().session.identity?.user.id;
      const changeRole=(id:string,role:string)=>mutate(()=>performAction(`/team/members/${encodeURIComponent(id)}`,{role},'PATCH'),'Role updated');
      const invite=()=>mutate(async()=>{
        await performAction('/team/invites',{email:c.state.sInv?.trim(),role:c.state.sInvRole || 'developer'});
        if(!disposed)c.setState({sInv:''});
      },'Invitation created');
      const pending=invites.filter((invite:any)=>!invite.accepted_at && new Date(invite.expires_at).getTime()>Date.now());
      values.cards=[card({title:'Invite a teammate',rows:[R.input('Email address','Creates a 72-hour invitation.',c.state.sInv || '',(event:Event)=>c.setState({sInv:(event.target as HTMLInputElement).value}),{ph:'name@yourcompany.com'}),R.seg('Role','Only server-supported roles are offered.',c.state.sInvRole || 'developer',roles,(role:string)=>c.setState({sInvRole:role}),[btn('Send invite',invite,'p')])]}),
        card({title:'Members',desc:failure || (loaded?`${members.length} active member${members.length===1?'':'s'}`:feedback()),rows:members.map(member=>member.role==='owner' || member.user_id===self?
          R.status(member.name || member.email,`${member.email} · ${member.mfa_enabled?'2FA on':'2FA off'}`,human(member.role),'neutral'):
          R.seg(member.name || member.email,`${member.email} · ${member.mfa_enabled?'2FA on':'2FA off'}`,member.role,roles,(role:string)=>changeRole(member.user_id,role),[btn('Remove',()=>{if(window.confirm(`Remove ${member.email} from this workspace?`))mutate(()=>performAction(`/team/members/${encodeURIComponent(member.user_id)}`,undefined,'DELETE'),'Member removed');},'d')]))}),
        card({title:'Pending invitations',desc:pending.length?`${pending.length} waiting to be accepted`:'No pending invitations',rows:pending.map(invite=>R.status(invite.email,`Expires ${new Date(invite.expires_at).toLocaleDateString()}`,human(invite.role),'neutral',null,[btn('Revoke',()=>mutate(()=>performAction(`/team/invites/${encodeURIComponent(invite.id)}`,undefined,'DELETE'),'Invitation revoked'),'d')]))})];
      values.sHasDirty=false;
    }else if(c.state.sTab==='security'){
      const identity=store.getState().session.identity;
      values.cards=[card({title:'Sign-in',rows:[R.status('Two-factor authentication','Status of your own account.',identity?.user.mfa_enabled?'Enabled':'Not enrolled',identity?.user.mfa_enabled?'good':'warn'),status('Workspace sign-in policy','No simulated enforcement settings are applied.')]}),
        card({title:'Active sessions',desc:failure || (loaded?`${sessions.length} sessions`:feedback()),table:{cols:[['Device'],['IP'],['Last active']],rows:sessions.map(session=>({cells:[session.user_agent || 'Unknown device',{v:session.ip || '—',mono:true},new Date(session.last_seen_at || session.created_at).toLocaleString()],acts:session.current?[]:[btn('Revoke',()=>mutate(()=>performAction(`/auth/sessions/${encodeURIComponent(session.id)}`,undefined,'DELETE'),'Session revoked'),'d')]}))}}),
        card({title:'Audit log',rows:[R.text('Audit history','No audit events have been loaded. Export is not yet connected.',[])]})];
      values.sHasDirty=false;
    }else if(c.state.sTab==='billing'){
      const usage=(key:string,label:string)=>{const data=quota?.[key];const percentage=data?Math.min(100,Math.max(0,Math.round(data.pct*100))):0;return R.bar(label,data?`${Number(data.used).toLocaleString()} of ${Number(data.limit).toLocaleString()}`:feedback(),[[percentage,'oklch(0.60 0.14 155)',`${percentage}% used`]],`${percentage}%`);};
      values.cards=[card({title:'Usage this cycle',desc:failure || 'Current quota counters',rows:[usage('daily','Daily emails'),usage('monthly','Monthly emails')]}),card({title:'Plan',rows:[R.status('Current plan',billing?`Tier: ${billing.tier}`:feedback(),billing?.plan || 'Loading','neutral'),R.status('Billing status','Reported by the billing service.',billing?.billing_status || 'Unknown','neutral')]}),card({title:'Payment & invoices',desc:invoices.length?`${invoices.length} invoice${invoices.length===1?'':'s'}`:'No invoices yet',rows:[R.status('Payment method','Card details are managed by your billing provider.',billing?.has_billing_account?'Billing account linked':'No billing account','neutral')],table:{cols:[['Invoice'],['Status'],['Currency'],['Amount','right']],rows:invoices.map(invoice=>({cells:[invoice.provider_invoice_id || invoice.id,invoice.status,invoice.currency,(Number(invoice.amount_cents)/100).toFixed(2)]}))}})];
      values.sHasDirty=false;
    }else{
      // Keep the original card/row structure, without claiming signed legal
      // agreements, connected Slack, or enforced policies that do not exist.
      values.cards=values.cards.map((item:any)=>card({title:item.title,rows:(item.rows || []).map((row:any)=>status(row.label,'This capability has not been configured for this workspace.'))}));
      values.sHasDirty=false;
    }
    return values;
  };
  return {refresh:()=>c.state.view==='settings' && !busy?refresh():Promise.resolve(),mount(){if(c.state.view==='settings')void refresh();},changed(previous:Record<string,any>){if(c.state.view==='settings' && (previous.view!=='settings' || previous.sTab!==c.state.sTab))void refresh();},dispose(){disposed=true;sequence++;}};
}
