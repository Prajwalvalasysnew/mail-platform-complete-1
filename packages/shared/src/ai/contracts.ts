import { z } from 'zod';

/** A failure the user can act on; its message is shown instead of the generic retry text. */
export class AiUserFacingError extends Error{constructor(public userMessage:string,code='ai_user_facing'){super(code);}}
import {renderEmailLayout} from './email-layout.js';
import {ReadPlan,READ_PLAN_FORMAT,type ReadCall} from './tool-contracts.js';

const plain = (max: number) => z.string().trim().min(1).max(max).refine(s => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), 'Invalid text');
export const AiInput = z.object({
  operation: z.enum(['subjects', 'rewrite', 'draft', 'chat', 'compact', 'route', 'assist', 'editor', 'workflow']),
  instruction: z.string().trim().max(4000).default(''),
  // Editor/assist turns carry the canvas HTML (tool state); every other operation stays small.
  content: z.string().max(90000).default(''),
  subject: z.string().max(998).default(''),
  tone: z.enum(['Friendly', 'Professional', 'Urgent']).default('Friendly'),
}).strict().superRefine((v, ctx) => {
  if (['draft','chat','compact','route','assist','editor','workflow'].includes(v.operation) ? !v.instruction : !v.content.trim() && !v.subject.trim()) ctx.addIssue({ code: 'custom', message: 'Add content or a writing brief.' });
  if (v.operation === 'rewrite' && !v.content.trim()) ctx.addIssue({ code: 'custom', message: 'Select text to rewrite.' });
  if (!['editor','assist','workflow'].includes(v.operation) && v.content.length>18000) ctx.addIssue({ code: 'custom', message: 'Content is too long.' });
});
export type AiInput = z.infer<typeof AiInput>;
const Block = z.object({
  type: z.enum(['heading', 'paragraph', 'button', 'feature', 'quote']), text: plain(2000),
  url: z.string().max(2048).default(''),
}).strict();
const Subjects = z.object({ subjects: z.array(plain(80).refine(s => !/[\r\n]/.test(s))).min(3).max(5) }).strict();
const Rewrite = z.object({ text: plain(12000) }).strict();
const Design=z.object({theme:z.enum(['indigo','ocean','forest','charcoal','rose']),layout:z.enum(['showcase','editorial','minimal']),eyebrow:z.string().max(80),footer:z.string().max(300)}).strict();
const Draft = z.object({ subject: plain(80).refine(s => !/[\r\n]/.test(s)), preheader: z.string().max(150), blocks: z.array(Block).min(1).max(12),design:Design.optional() }).strict();
export type AiOutput = {operation:'workflow';name:string;document:unknown;issues:string[];message:string;changes:string[]} | {operation:'route';calls:ReadCall[]} | { operation:'compact';summary:string } | { operation: 'chat'; text: string } | { operation: 'subjects'; subjects: string[] } | { operation: 'rewrite'; text: string } | { operation: 'draft'; subject: string; preheader: string; html: string; text: string; message?:string; design?:z.infer<typeof Design>; changes?:string[] };

const AI_FORMATS_BASE = {
  route:READ_PLAN_FORMAT,
  compact: {type:'object',properties:{summary:{type:'string',maxLength:3000}},required:['summary'],additionalProperties:false},
  chat: { type: 'object', properties: { text: { type: 'string', maxLength: 12000 } }, required: ['text'], additionalProperties: false },
  subjects: { type: 'object', properties: { subjects: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string', maxLength: 80 } } }, required: ['subjects'], additionalProperties: false },
  rewrite: { type: 'object', properties: { text: { type: 'string', maxLength: 12000 } }, required: ['text'], additionalProperties: false },
  draft: {type:'object',properties:{
    subject:{type:'string',maxLength:80},preheader:{type:'string',maxLength:150},
    blocks:{type:'array',minItems:1,maxItems:12,items:{type:'object',properties:{type:{type:'string',enum:['heading','paragraph','button','feature','quote']},text:{type:'string',maxLength:2000},url:{type:'string',maxLength:2048}},required:['type','text','url'],additionalProperties:false}},
    design:{type:'object',properties:{theme:{type:'string',enum:['indigo','ocean','forest','charcoal','rose']},layout:{type:'string',enum:['showcase','editorial','minimal']},eyebrow:{type:'string',maxLength:80},footer:{type:'string',maxLength:300}},required:['theme','layout','eyebrow','footer'],additionalProperties:false}
  },required:['subject','preheader','blocks','design'],additionalProperties:false},
} as const;
export const CONVERSATION_FORMAT={type:'object',properties:{reply:{type:'string',maxLength:12000},draft:{anyOf:[AI_FORMATS_BASE.draft,{type:'null'}]}},required:['reply','draft'],additionalProperties:false} as const;
export const AI_FORMATS={...AI_FORMATS_BASE,assist:CONVERSATION_FORMAT,editor:CONVERSATION_FORMAT,workflow:CONVERSATION_FORMAT} as const;

/** Escape generated text; the model never supplies executable HTML. */
export function aiEscape(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function mergeTags(s: string): string[] { return (s.match(/{{[^{}]+}}/g) || []).sort(); }
function urls(s:string):string[]{return s.match(/https?:\/\/[^\s<>"']+/g) || [];}
function checkLinks(input:AiInput,text:string){
  const allowed=new Set(urls(`${input.instruction}\n${input.content}\n${input.subject}`));
  if(urls(text).some(url=>!allowed.has(url)))throw new Error('Only supplied links may be used');
}

/** Validate model JSON and render a small fixed email vocabulary. */
export function validateAiOutput(input: AiInput, value: unknown): AiOutput {
  if(input.operation==='assist' || input.operation==='editor'){
    const response=z.object({reply:plain(12000),draft:Draft.nullable()}).strict().parse(value);
    if(response.draft && input.operation==='editor' && /\b(?:do not|don't)\s+(?:change|modify|edit|replace)\s+(?:the|my|this)\s+(?:email|template|canvas|draft)\b/i.test(input.instruction))throw new Error('The user forbids editing the email. Return draft=null and answer in reply.');
    if(!response.draft)return {operation:'chat',text:response.reply};
    const rendered=validateAiOutput({...input,operation:'draft'},response.draft);
    if(rendered.operation!=='draft')throw new Error('Invalid proposal');
    return {...rendered,message:response.reply};
  }
  if(input.operation==='route')return {operation:'route',...ReadPlan.parse(value)};
  if (input.operation === 'compact') return {operation:'compact',...z.object({summary:plain(3000)}).strict().parse(value)};
  if (input.operation === 'chat') return {operation:'chat',...Rewrite.parse(value)};
  if (input.operation === 'subjects') {
    const parsed = Subjects.parse(value);
    if (new Set(parsed.subjects).size !== parsed.subjects.length) throw new Error('Duplicate subjects');
    return { operation: 'subjects', ...parsed };
  }
  if (input.operation === 'rewrite') {
    const parsed = Rewrite.parse(value);
    checkLinks(input,parsed.text);
    if (JSON.stringify(mergeTags(input.content)) !== JSON.stringify(mergeTags(parsed.text))) throw new Error('Merge tags changed');
    if (parsed.text.length > Math.max(200, input.content.length * 3)) throw new Error('Rewrite too long');
    return { operation: 'rewrite', ...parsed };
  }
  const parsed = Draft.parse(value);
  checkLinks(input,[parsed.subject,parsed.preheader,...parsed.blocks.map(b=>b.text)].join('\n'));
  const supplied = new Set((`${input.instruction}\n${input.content}`.match(/https?:\/\/[^\s<>"']+/g) || []));
  for(const block of parsed.blocks){
    if(block.type==='button'){
      const url=new URL(block.url);
      if(!['https:','http:'].includes(url.protocol) || url.username || url.password || !supplied.has(block.url))throw new Error('Only supplied links may be used');
    }else if(block.url)throw new Error('Unexpected link');
  }
  const design=parsed.design || {theme:'indigo' as const,layout:'showcase' as const,eyebrow:'',footer:''};
  checkLinks(input,`${design.eyebrow} ${design.footer}`);
  const permittedTags=new Set(mergeTags(input.instruction+' '+input.content));
  if(mergeTags(JSON.stringify(parsed)).some(tag=>!permittedTags.has(tag)))throw new Error('Do not invent merge tags');
  const html=renderEmailLayout(parsed.blocks,parsed.preheader,design,/short additional email section/i.test(input.instruction));
  const text = parsed.blocks.map(b => b.text + (b.url ? `\n${b.url}` : '')).join('\n\n');
  if (html.length > 40000) throw new Error('Draft too large');
  return { operation: 'draft', subject: parsed.subject, preheader: parsed.preheader, html, text,design };
}
