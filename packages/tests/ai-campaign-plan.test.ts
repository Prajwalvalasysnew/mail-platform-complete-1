import {describe,expect,it} from 'vitest';
import {CampaignPlan,segmentRules,linkPolicy,MAX_CAMPAIGN_EMAILS,DocumentToolError} from '@platform/shared';

const blocks=[{type:'heading',text:'We saved your spot'},{type:'paragraph',text:'Here is what is new.'},{type:'button',text:'See what is new',url:'#'}];
const open=linkPolicy('Link the button to https://acme.example.test/new','');

describe('AI campaign plan',()=>{
 it('accepts the documented segment rules and close spellings models use',()=>{
  expect(segmentRules([{field:'Opened any email',op:'not in last',val:'30 days'}])).toEqual([{field:'Opened any email',op:'not in last',val:'30 days'}]);
  expect(segmentRules([{field:'opened_any_email',operator:'not_in_last',value:'30d'},{field:'clicks',op:'without',days:60},{field:'created_at',op:'in last',val:'7'}])).toEqual([
   {field:'Opened any email',op:'not in last',val:'30 days'},{field:'Clicked any email',op:'not in last',val:'60 days'},{field:'Created',op:'in last',val:'7 days'}]);
  for(const bad of [[],[{field:'Purchased',op:'in last',val:'30 days'}],[{field:'Created',op:'in last',val:'45 days'}],Array.from({length:11},()=>({field:'Created',op:'in last',val:'7 days'}))])
   expect(()=>segmentRules(bad)).toThrow(DocumentToolError);
 });
 it('renders emails in the trusted layout with an unsubscribe link and keeps edits by key',()=>{
  const plan=new CampaignPlan();
  const first=plan.upsertEmail({key:'Win Back 1',name:'Win-back 1',subject:'  We saved\nyour spot ',blocks},open);
  expect(first.email).toMatchObject({key:'win-back-1',subject:'We saved your spot'});
  expect(first.email.html).toContain('href="{{unsubscribe_url}}"');expect(first.email.text).toContain('{{unsubscribe_url}}');
  // A plain-text heading is added when the model forgets one, and copy is escaped.
  const second=plan.upsertEmail({key:'two',subject:'Two',blocks:[{type:'paragraph',text:'<script>alert(1)</script>'},{type:'cta',label:'Shop',href:'acme.example.test/new'}]},open);
  expect(second.email.blocks[0]).toEqual({type:'heading',text:'Two',url:''});
  expect(second.email.html).not.toContain('<script>');expect(second.email.blocks.at(-1)).toEqual({type:'button',text:'Shop',url:'https://acme.example.test/new'});
  const rewritten=plan.upsertEmail({key:'win-back-1',subject:'Still there?'},open);
  expect(rewritten.replaced).toBe(true);expect(rewritten.email.blocks).toEqual(first.email.blocks);
  expect(plan.emails.map(e=>e.key)).toEqual(['win-back-1','two']);
  expect(plan.email('draft:two')?.subject).toBe('Two');
  plan.removeEmail('two');expect(plan.emails).toHaveLength(1);
  expect(()=>plan.removeEmail('two')).toThrow(/No campaign email/);
 });
 it('rejects links, merge tags and sizes the user did not allow',()=>{
  const plan=new CampaignPlan();
  expect(()=>plan.upsertEmail({key:'a',subject:'Hi',blocks:[{type:'heading',text:'Hi'},{type:'button',text:'Go',url:'https://evil.example.test'}]},open)).toThrow(/was not provided by the user/);
  expect(()=>plan.upsertEmail({key:'a',subject:'Hi',blocks:[{type:'heading',text:'Hi {{secret_token}}'},{type:'paragraph',text:'x'}]},open)).toThrow(/does not exist/);
  expect(()=>plan.upsertEmail({key:'a',subject:'',blocks},open)).toThrow(/subject is required/);
  expect(()=>plan.upsertEmail({key:'a',subject:'Hi',blocks:[{type:'heading',text:'Only one'}]},open)).toThrow(/2-14/);
  expect(()=>plan.upsertEmail({key:'a',subject:'Hi',blocks:[{type:'video',text:'x'},{type:'paragraph',text:'y'}]},open)).toThrow(/type must be one of/);
  expect(plan.isBlank()).toBe(true);
  for(let i=0;i<MAX_CAMPAIGN_EMAILS;i++)plan.upsertEmail({key:`e${i}`,subject:`Email ${i}`,blocks},open);
  expect(()=>plan.upsertEmail({key:'extra',subject:'One more',blocks},open)).toThrow(/at most/);
 });
 it('describes itself for follow-up turns and round-trips through a saved result',()=>{
  const plan=new CampaignPlan();
  plan.setSegment({name:'Inactive 30 days',kind:'segment',rules:[{field:'Opened any email',op:'not in last',val:'30 days'}],audience_id:null,matching:2318,sendable:2201});
  plan.upsertEmail({key:'winback-1',name:'Win-back 1',subject:'We saved your spot',blocks},open);
  const view=plan.view();
  expect(view).toContain('“Inactive 30 days” (Opened any email not in last 30 days): 2318 contacts match, 2201 can receive marketing email');
  expect(view).toContain('Email draft:winback-1 “Win-back 1”');expect(view).toContain('[button] See what is new (#)');
  const restored=new CampaignPlan(JSON.parse(JSON.stringify({segment:plan.segment,emails:plan.emails})));
  expect(restored.snapshot()).toBe(plan.snapshot());
 });
});
