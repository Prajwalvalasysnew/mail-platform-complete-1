/** Multi-artifact campaign the assistant builds in one turn: an audience, several emails and
 * (with the workflow tools) the journey that sends them. Nothing here is saved; the user
 * approves each part, and launching is a separate, explicit approval.
 */
import {z} from 'zod';
import {SegmentRule,SEGMENT_RULE_FIELDS,SEGMENT_RULE_OPS,SEGMENT_RULE_WINDOWS} from '../audiences.js';
import {renderEmailLayout,newsletterDesignFromBrief,type EmailDesign} from './email-layout.js';
import {DocumentToolError,policyProblems,type LinkPolicy} from './email-html.js';
import {validateTemplate} from '../templates.js';

/** Workflow email steps reference unsaved campaign emails as "draft:<key>" until approval. */
export const DRAFT_TEMPLATE_PREFIX='draft:';
export const MAX_CAMPAIGN_EMAILS=6;
const THEMES=['indigo','ocean','forest','charcoal','rose'] as const,LAYOUTS=['showcase','editorial','minimal','newsletter'] as const;
const BLOCK_TYPES=['heading','paragraph','button','feature','quote','cta'] as const;

export type CampaignSegment={name:string;kind:'segment'|'list';rules:SegmentRule[];audience_id:string|null;matching:number;sendable:number};
export type CampaignBlock={type:typeof BLOCK_TYPES[number];text:string;url:string;title?:string;label?:string};
export type CampaignEmail={key:string;name:string;subject:string;preheader:string;design:EmailDesign;blocks:CampaignBlock[];html:string;text:string};
export type CampaignSeed={segment?:CampaignSegment|null;emails?:CampaignEmail[]}|null;

const keyOf=(value:unknown)=>String(value ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,32);
const oneLine=(value:unknown,max:number)=>String(value ?? '').replace(/\s+/g,' ').trim().slice(0,max);

/** Accept the documented rule shape plus close spellings ("operator", "value", "not_in_last", "30d"). */
export function segmentRules(raw:unknown):SegmentRule[]{
 if(!Array.isArray(raw) || !raw.length || raw.length>10)throw new DocumentToolError('rules must be a list of 1-10 rules, e.g. [{field:"Opened any email",op:"not in last",val:"30 days"}].');
 return raw.map((r:any,i)=>{
  const field=SEGMENT_RULE_FIELDS.find(f=>f.toLowerCase()===String(r?.field ?? '').toLowerCase().replace(/_/g,' ').trim() || (/open/i.test(String(r?.field)) && f==='Opened any email') || (/click/i.test(String(r?.field)) && f==='Clicked any email') || (/creat|join|sign/i.test(String(r?.field)) && f==='Created'));
  const opText=String(r?.op ?? r?.operator ?? '').toLowerCase().replace(/_/g,' ').trim();
  const op=SEGMENT_RULE_OPS.find(o=>o===opText) || (/not|without|no /.test(opText)?'not in last':/in|within|last/.test(opText)?'in last':undefined);
  const days=Number(String(r?.val ?? r?.value ?? r?.days ?? '').match(/\d+/)?.[0]);
  const val=SEGMENT_RULE_WINDOWS.find(w=>Number(w.split(' ')[0])===days);
  const parsed=SegmentRule.safeParse({field,op,val});
  if(!parsed.success)throw new DocumentToolError(`Rule ${i+1} is not supported. Fields: ${SEGMENT_RULE_FIELDS.join(', ')}. Ops: ${SEGMENT_RULE_OPS.join(', ')}. Windows: ${SEGMENT_RULE_WINDOWS.join(', ')}.`);
  return parsed.data;
 });
}
export const describeRules=(rules:SegmentRule[])=>rules.map(r=>`${r.field} ${r.op} ${r.val}`).join(' and ');

const Design=z.object({theme:z.enum(THEMES).catch('indigo'),layout:z.enum(LAYOUTS).catch('showcase'),eyebrow:z.string().max(80).catch(''),footer:z.string().max(300).catch(''),accent:z.string().regex(/^#[0-9a-f]{6}$/i).optional().catch(undefined),brandName:z.string().max(100).optional(),tagline:z.string().max(160).optional(),ink:z.string().regex(/^#[0-9a-f]{6}$/i).optional(),background:z.string().regex(/^#[0-9a-f]{6}$/i).optional(),footerBackground:z.string().regex(/^#[0-9a-f]{6}$/i).optional(),websiteUrl:z.string().max(2048).optional()});

/** Render copy blocks in the trusted branded layout (escaped text, bulletproof button, unsubscribe footer). */
export function composeEmail(input:any,policy:LinkPolicy,brand:Partial<EmailDesign>={},brief=''){
 const subject=oneLine(input?.subject,80),preheader=oneLine(input?.preheader,150);
 if(!subject)throw new DocumentToolError('subject is required (at most 80 characters).');
 const rawBlocks=input?.blocks;
 if(!Array.isArray(rawBlocks) || rawBlocks.length<2 || rawBlocks.length>14)throw new DocumentToolError('blocks must be 2-14 items such as {type:"heading",text:"..."}, {type:"paragraph",text:"..."}, {type:"button",text:"Label",url:"#"}.');
 const blocks:CampaignBlock[]=rawBlocks.map((b:any,i:number)=>{
  const type=String(b?.type).toLowerCase()==='cta' && !b?.text && b?.label?'button':BLOCK_TYPES.find(t=>t===String(b?.type ?? '').toLowerCase()) || (String(b?.type).toLowerCase()==='cta'?'button':undefined);
  const text=String(b?.text ?? b?.label ?? '').trim().slice(0,2000);
  if(!type)throw new DocumentToolError(`Block ${i+1} type must be one of: ${BLOCK_TYPES.join(', ')}.`);
  if(!text)throw new DocumentToolError(`Block ${i+1} needs text.`);
  const url=type==='button' || type==='cta'?String(b?.url ?? b?.href ?? '#').trim() || '#':'';
  return {type,text,...(b.title?{title:oneLine(b.title,160)}:{}),...(b.label && type==='cta'?{label:oneLine(b.label,80)}:{}),url:url && url!=='#' && !/^(https?:|mailto:|{{)/i.test(url)?`https://${url}`:url};
 });
 if(!blocks.some(b=>b.type==='heading'))blocks.unshift({type:'heading',text:subject,url:''});
 const design:EmailDesign=newsletterDesignFromBrief(Design.parse({...brand,...(input?.design && typeof input.design==='object'?input.design:{})}),brief);
 const html=renderEmailLayout(blocks,preheader,design,false,true);
 const problems=policyProblems(html,policy);
 if(problems.length)throw new DocumentToolError(`Email rejected, nothing was changed: ${problems.join('; ')}.`);
 const text=[design.brandName,design.tagline,...blocks.map(b=>[b.title,b.text,b.label].filter(Boolean).join('\n')+(b.url && b.url!=='#'?`\n${b.url}`:'')),design.footer,'Unsubscribe: {{unsubscribe_url}}'].filter(Boolean).join('\n\n');
 for(const field of [subject,html,text])if(!validateTemplate(field).valid)throw new DocumentToolError('The email contains template syntax that cannot be saved. Remove unusual braces.');
 return {subject,preheader,design,blocks,html,text};
}

/** Brand defaults from workspace memory ("Brand colour: #d6343c"). */
export function brandFromMemory(facts:string){const hex=facts.match(/brand\s*colou?r[^#\n]*(#[0-9a-f]{6})\b/i)?.[1];return hex?{accent:hex.toLowerCase()}:{};}

export class CampaignPlan{
 segment:CampaignSegment|null;emails:CampaignEmail[];
 constructor(seed:CampaignSeed=null){this.segment=seed?.segment?structuredClone(seed.segment):null;this.emails=structuredClone(seed?.emails || []);}
 isBlank(){return !this.segment && !this.emails.length;}
 snapshot(){return JSON.stringify({segment:this.segment,emails:this.emails});}
 email(key:string){return this.emails.find(e=>e.key===keyOf(key.startsWith(DRAFT_TEMPLATE_PREFIX)?key.slice(DRAFT_TEMPLATE_PREFIX.length):key));}
 setSegment(segment:CampaignSegment){this.segment=segment;}

 /** Create or replace one campaign email, rendered in the trusted branded layout. */
 upsertEmail(input:any,policy:LinkPolicy,brand:Partial<EmailDesign>={}):{email:CampaignEmail;replaced:boolean}{
  if(!input || typeof input!=='object')throw new DocumentToolError('Provide {key, name, subject, preheader, blocks}.');
  const key=keyOf(input.key || input.name);
  if(!key)throw new DocumentToolError('Give the email a short key such as "winback-1".');
  const existing=this.emails.find(e=>e.key===key);
  if(!existing && this.emails.length>=MAX_CAMPAIGN_EMAILS)throw new DocumentToolError(`A campaign can have at most ${MAX_CAMPAIGN_EMAILS} emails. Replace an existing one by its key: ${this.emails.map(e=>e.key).join(', ')}.`);
  const subject=oneLine(input.subject ?? existing?.subject,80),name=oneLine(input.name ?? existing?.name ?? subject,120),preheader=oneLine(input.preheader ?? existing?.preheader,150);
  if(!subject)throw new DocumentToolError('subject is required (at most 80 characters).');
  const {design,blocks,html,text}=composeEmail({...input,subject,preheader,blocks:Array.isArray(input.blocks)?input.blocks:existing?.blocks,design:{...existing?.design,...(input.design && typeof input.design==='object'?input.design:{})}},policy,brand);
  const email:CampaignEmail={key,name,subject,preheader,design,blocks,html,text};
  if(existing)this.emails=this.emails.map(e=>e.key===key?email:e);else this.emails.push(email);
  return {email,replaced:!!existing};
 }
 removeEmail(key:string){const email=this.email(key);if(!email)throw new DocumentToolError(`No campaign email ${key}. Keys: ${this.emails.map(e=>e.key).join(', ') || 'none'}.`);this.emails=this.emails.filter(e=>e!==email);return email;}

 view(){
  const lines=['Campaign plan'];
  lines.push(this.segment?`Audience: ${this.segment.audience_id?'existing ':''}${this.segment.kind} “${this.segment.name}”${this.segment.rules.length?` (${describeRules(this.segment.rules)})`:''}: ${this.segment.matching} contacts match, ${this.segment.sendable} can receive marketing email.`:'Audience: not defined yet.');
  if(!this.emails.length)lines.push('Emails: none yet.');
  for(const e of this.emails)lines.push(`Email ${DRAFT_TEMPLATE_PREFIX}${e.key} “${e.name}” — subject “${e.subject}”${e.preheader?`, preview “${e.preheader}”`:''}\n  ${e.blocks.map(b=>`[${b.type}] ${b.text.slice(0,160)}${b.url?` (${b.url})`:''}`).join('\n  ')}`);
  return lines.join('\n');
 }
}
