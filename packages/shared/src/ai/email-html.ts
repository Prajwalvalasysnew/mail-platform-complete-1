/** Working email document for the AI agent: sanitized HTML with stable per-run element IDs.
 * The model writes real email HTML (tables + inline styles); the platform removes anything
 * executable and enforces the link policy before a result can reach the editor.
 */
import {load,type CheerioAPI} from 'cheerio';
import type {AnyNode,Element} from 'domhandler';

const DROP=new Set(['script','style','iframe','frame','frameset','object','embed','applet','form','input','button','textarea','select','option','link','meta','base','svg','math','template','noscript','video','audio','source','track','canvas','title','head','param','portal','dialog']);
const TAGS=new Set(['table','thead','tbody','tfoot','tr','td','th','caption','colgroup','col','div','span','p','a','img','h1','h2','h3','h4','h5','h6','strong','b','em','i','u','s','br','hr','ul','ol','li','blockquote','center','font','small','sup','sub','section','header','footer','article','aside','main','nav','figure','figcaption','picture','pre','code','mark','del','ins','abbr','cite','q','dl','dt','dd']);
const ATTRS=new Set(['style','href','src','alt','title','width','height','align','valign','bgcolor','background','border','cellpadding','cellspacing','role','class','target','rel','colspan','rowspan','dir','lang','color','face','size','name','data-ai','aria-label','aria-hidden','scope','start','type','id']);
/** Merge tags the platform fills at send time; any other tag must already exist in the user's content. */
export const PLATFORM_MERGE_TAGS=['first_name','last_name','company','unsubscribe_url','preferences_url'];
const BLOCKISH=new Set(['table','tr','td','th','div','p','a','img','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','hr','section','header','footer','article','center','figure','span']);

export class DocumentToolError extends Error {}

/** Explicitly quoted headings and button labels are required copy, not suggestions. */
export function missingEmailCopy(instruction:string,html:string):string[]{
 if(/\b(remove|delete|omit|without|do not|don't)\s+(?:the\s+)?(?:heading|headline|title|eyebrow|tagline|button)/i.test(instruction))return [];
 const required=new Set<string>();
 for(const pattern of [/(?:heading|headline|title|eyebrow|tagline|button(?: caption| label)?)\s*(?:of|:|=)?\s*["“]([^"”\n]{1,160})["”]/gi,/["“]([^"”\n]{1,160})["”]\s+(?:section|button|heading|headline)\b/gi]){
  for(const match of instruction.matchAll(pattern))required.add(match[1]!.trim());
 }
 const $=load(sanitizeEmailHtml(html),null,false);
 $('[style]').each((_i,element)=>{if(/display\s*:\s*none/i.test($(element).attr('style') || ''))$(element).remove();});
 const normalize=(text:string)=>text.toLowerCase().replace(/\s+/g,' ').trim(),text=normalize($.root().text());
 return [...required].filter(value=>!text.includes(normalize(value)));
}

function cleanCss(value:string){
 return value.split(';').map(part=>{
  const index=part.indexOf(':');if(index<1)return '';
  const prop=part.slice(0,index).trim().toLowerCase(),val=part.slice(index+1).trim();
  if(!/^-?[a-z][a-z0-9-]*$/.test(prop) || !val || val.length>500)return '';
  if(/expression\s*\(|javascript:|vbscript:|@import|behavior\s*:|-moz-binding|[<>\\]/i.test(val))return '';
  // At most one url(), and it must be https; policyProblems also checks it against the allowed links.
  const urls=val.match(/url\s*\(/gi);
  if(urls && (urls.length>1 || !/^url\(\s*['"]?https:\/\/[^'")\s]+['"]?\s*\)/i.test(val.replace(/^.*?(url\()/i,'$1'))))return '';
  return `${prop}:${val}`;
 }).filter(Boolean).join(';');
}
function safeUrl(value:string,image=false){
 const v=value.trim();
 if(/^{{\s*[\w.]+\s*}}$/.test(v))return v;
 if(!image && (v==='#' || /^(mailto|tel):[^\s<>"']+$/i.test(v)))return v;
 try{const url=new URL(v);return ['http:','https:'].includes(url.protocol) && !url.username && !url.password?v:null;}catch{return null;}
}

/** Remove executable markup and unsupported elements; unknown harmless wrappers are unwrapped. */
export function sanitizeEmailHtml(html:string):string{
 const $=load(html,null,false);
 const visit=(nodes:AnyNode[])=>{
  for(const node of [...nodes]){
   if(node.type==='comment' || node.type==='directive' || node.type==='cdata'){$(node).remove();continue;}
   if(node.type!=='tag' && node.type!=='script' && node.type!=='style')continue;
   const el=node as Element,tag=el.name.toLowerCase();
   if(DROP.has(tag) || node.type==='script' || node.type==='style'){$(el).remove();continue;}
   visit(el.children);
   if(!TAGS.has(tag)){$(el).replaceWith(el.children);continue;}
   for(const [name,raw] of Object.entries({...el.attribs})){
    const key=name.toLowerCase();
    if(!ATTRS.has(key) || key.startsWith('on')){$(el).removeAttr(name);continue;}
    if(key==='style'){const css=cleanCss(raw);css?$(el).attr(name,css):$(el).removeAttr(name);}
    else if(key==='href' || key==='src' || key==='background'){const url=safeUrl(raw,key!=='href');url===null?$(el).removeAttr(name):$(el).attr(name,url);}
    else if(key==='target' && raw!=='_blank')$(el).removeAttr(name);
   }
   if(tag==='a' && el.attribs.target)$(el).attr('rel','noopener noreferrer');
  }
 };
 visit($.root()[0]!.children);
 return $.html();
}

const URL_RE=/\b(?:https?:\/\/[^\s<>"'`)\]]+|(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:com|net|org|io|ai|co|app|dev|in|us|uk|de|fr|biz|info|tech|cloud|so|me|xyz|email|mail|site|online|store|shop)(?:\/[^\s<>"'`)\]]*)?)/gi;
/** Normalize a URL for policy comparison; bare domains the user typed become https URLs. */
export function normalizeUrl(raw:string):string|null{
 let v=raw.trim().replace(/[.,;:!?]+$/,'');
 if(!v)return null;
 if(!/^[a-z][a-z0-9+.-]*:/i.test(v))v='https://'+v;
 try{const url=new URL(v);if(!['http:','https:'].includes(url.protocol) || url.username || url.password)return null;
  const path=url.pathname.replace(/\/+$/,'');return `${url.host.toLowerCase()}${path}${url.search}${url.hash}`;}catch{return null;}
}
/** Links mentioned in user-authored text, including bare domains such as "valasys.com". */
export function extractUserUrls(text:string):string[]{
 const found=new Set<string>();
 for(const match of text.match(URL_RE) || []){const url=/^https?:/i.test(match)?match:`https://${match}`;if(normalizeUrl(url))found.add(url.replace(/[.,;:!?]+$/,''));}
 return [...found];
}

export type LinkPolicy={allowed:Set<string>;tags:Set<string>};
/** https URLs inside CSS url(...) values of style attributes. */
const cssUrls=(style:string)=>[...style.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi)].map(m=>m[1]!);
export function linkPolicy(userText:string,documentHtml:string,extraUrls:string[]=[]):LinkPolicy{
 const allowed=new Set<string>(),tags=new Set(PLATFORM_MERGE_TAGS);
 const add=(u:string)=>{const n=normalizeUrl(u);if(n)allowed.add(n);};
 extractUserUrls(userText).forEach(add);extraUrls.forEach(add);
 const $=load(documentHtml,null,false);
 // Links already in the user's email stay allowed, including mailto: addresses and CSS background images.
 $('[href],[src],[background]').each((_,el)=>{for(const key of ['href','src','background']){const v=$(el).attr(key)?.trim();if(!v)continue;if(/^https?:/i.test(v))add(v);else if(/^mailto:/i.test(v))allowed.add(v.toLowerCase().split('?')[0]!);}});
 $('[style]').each((_,el)=>{cssUrls($(el).attr('style') || '').forEach(add);});
 for(const m of `${userText}\n${documentHtml}`.matchAll(/{{\s*([\w.]+)\s*}}/g))tags.add(m[1]!);
 for(const m of userText.matchAll(/(?:mailto:)?([\w.+-]+@[\w-]+\.[\w.-]+)/g))allowed.add(`mailto:${m[1]!.toLowerCase()}`);
 return {allowed,tags};
}
/** Enforce the link and merge-tag policy on HTML the model wrote. Returns the problems found. */
export function policyProblems(html:string,policy:LinkPolicy):string[]{
 const $=load(html,null,false),problems=new Set<string>();
 $('[href],[src],[background]').each((_,el)=>{for(const key of ['href','src','background']){
  const v=$(el).attr(key)?.trim();if(!v || v==='#' || /^{{\s*[\w.]+\s*}}$/.test(v))continue;
  if(/^tel:/i.test(v))continue;
  if(/^mailto:/i.test(v)){if(!policy.allowed.has(v.toLowerCase().split('?')[0]!))problems.add(`Email address in ${v} was not provided by the user`);continue;}
  const n=normalizeUrl(v);
  if(!n || !policy.allowed.has(n))problems.add(`${v} was not provided by the user. Use only links the user gave (or href="#" and ask for the link)`);
 }});
 $('[style]').each((_,el)=>{for(const v of cssUrls($(el).attr('style') || '')){const n=normalizeUrl(v);if(!n || !policy.allowed.has(n))problems.add(`${v} was not provided by the user. Use only image URLs the user gave`);}});
 for(const m of html.matchAll(/{{\s*([\w.]+)\s*}}/g))if(!policy.tags.has(m[1]!))problems.add(`Merge tag {{${m[1]}}} does not exist. Available: ${[...policy.tags].map(t=>`{{${t}}}`).join(', ')}`);
 return [...problems];
}

const squash=(s:string,max:number)=>{const t=s.replace(/\s+/g,' ').trim();return t.length>max?t.slice(0,max-1)+'…':t;};

/** Class the template editor adds to the user's selected block in the HTML it sends (never saved). */
export const SELECTED_CLASS='vx-ai-selected';
/** Mutable working copy; every element carries a data-ai ID the model can target. */
export class EmailDocument{
 private $:CheerioAPI;private next=1;
 subject:string;preheader:string;
 constructor(html:string,subject='',preheader=''){
  this.$=load(sanitizeEmailHtml(html || ''),null,false);this.subject=subject;this.preheader=preheader;
  this.$('[data-ai]').removeAttr('data-ai');this.tag(this.$.root());
  // The editor marks the block the user selected; remember its id and strip the marker.
  const marked=this.$(`.${SELECTED_CLASS}`);
  if(marked.length===1)this.selected=marked.attr('data-ai');
  marked.each((_,el)=>{const $el=this.$(el),rest=($el.attr('class') || '').split(/\s+/).filter(c=>c && c!==SELECTED_CLASS).join(' ');if(rest)$el.attr('class',rest);else $el.removeAttr('class');});
 }
 /** data-ai id of the element the user selected in the editor, if any. */
 selected?:string;
 private tag(scope:ReturnType<CheerioAPI>){
  const $=this.$;
  scope.find('*').addBack('*').each((_,el)=>{if(el.type==='tag' && !$(el).attr('data-ai'))$(el).attr('data-ai',`e${this.next++}`);});
 }
 private find(id:string){
  if(!/^e\d{1,6}$/.test(id))throw new DocumentToolError(`Unknown element id "${id}". Use an id from view_email, such as e3.`);
  const el=this.$(`[data-ai="${id}"]`);if(!el.length)throw new DocumentToolError(`Element ${id} does not exist (it may have been removed). Call view_email for current ids.`);
  return el.first();
 }
 /** Parse model HTML into tagged nodes. */
 private fragment(html:string){
  const clean=sanitizeEmailHtml(html);
  if(!clean.trim())throw new DocumentToolError('The HTML was empty after removing unsupported or unsafe markup (scripts, forms, <style>, event handlers). Use tables, divs, text and inline styles.');
  const $f=load(clean,null,false);$f('[data-ai]').removeAttr('data-ai');
  return this.$($f.root().contents().toArray());
 }
 html(withIds=false){
  const copy=load(this.$.html(),null,false);if(!withIds)copy('[data-ai]').removeAttr('data-ai');
  return copy.html().trim();
 }
 text(){
  const $=load(this.html(),null,false),lines:string[]=[];
  $('br').replaceWith('\n');
  $('h1,h2,h3,h4,p,li,blockquote,a,td').each((_,el)=>{
   const node=$(el),tag=(el as Element).name;
   if(tag==='td' && node.find('h1,h2,h3,h4,p,li,blockquote,a,td,table').length)return;
   if(tag!=='a' && tag!=='td' && node.parents('a').length)return;
   if(tag==='a'){const href=node.attr('href');const t=squash(node.text(),200);if(t && href && href!=='#')lines.push(`${t}: ${href}`);else if(t && !node.parents('p,h1,h2,h3,h4,li').length)lines.push(t);return;}
   const t=node.clone().find('a').remove().end().text().replace(/[ \t]+/g,' ').trim();
   if(t)lines.push(/^h[1-4]$/.test(tag)?t.toUpperCase():t);
  });
  return [...new Set(lines)].join('\n\n').slice(0,20000);
 }
 plainLength(){return this.$.root().text().replace(/\s+/g,' ').trim().length;}
 isBlank(){const t=this.$.root().text().replace(/\s+/g,' ').trim();return t.length<60 || /^add your email content here\.?$/i.test(t);}
 /** Compact structural outline used when the full HTML would not fit the model context. */
 outline(max=9000){
  const $=this.$,lines:string[]=[];
  const walk=(el:Element,depth:number)=>{
   if(lines.join('\n').length>max)return;
   const node=$(el),tag=el.name;
   const kids=node.children().toArray() as Element[];
   if(BLOCKISH.has(tag)){
    const attrs=[node.attr('href')?`href=${node.attr('href')}`:'',node.attr('src')?`src=${node.attr('src')}`:'',node.attr('style')?`style="${squash(node.attr('style')!,140)}"`:'',node.attr('bgcolor')?`bgcolor=${node.attr('bgcolor')}`:''].filter(Boolean).join(' ');
    const own=kids.some(k=>BLOCKISH.has(k.name) && k.name!=='span')?'':squash(node.text(),110);
    lines.push(`${'  '.repeat(Math.min(depth,8))}${node.attr('data-ai')} <${tag}${attrs?' '+attrs:''}>${own?` "${own}"`:''}`);
    depth++;
   }
   if(tag==='p' || /^h\d$/.test(tag) || tag==='a')return;
   for(const kid of kids)walk(kid,depth);
  };
  for(const el of $.root().children().toArray() as Element[])walk(el,0);
  const out=lines.join('\n');return out.length>max?out.slice(0,max)+'\n… (outline truncated; use read_element on a container id to see more)':out;
 }
 /** What the model sees: real HTML when it fits, otherwise an outline plus read_element. */
 view(max=16000){
  const html=this.html(true);
  const head=`Subject: ${this.subject || '(empty)'}\nPreheader: ${this.preheader || '(empty)'}\n`;
  if(!this.plainLength() && !this.$('img').length)return `${head}The email canvas is empty.`;
  return html.length<=max?`${head}HTML (every element has a data-ai id you can target):\n${html}`:`${head}The email HTML is ${html.length} characters, so here is an outline (id, tag, key attributes, text). Use read_element to see exact HTML.\n${this.outline()}`;
 }
 describe(id:string){
  const el=this.find(id),tag=(el[0] as Element).name;
  const container=['table','tbody','tr','td','th','div','section','header','footer','center'].includes(tag);
  if(el.is('body') || container && el.find('table').length>0 && !el.parents('table').length)return 'email background';
  const label=tag==='a'?'link':/^h[1-2]$/.test(tag)?'headline':/^h\d$/.test(tag)?'heading':tag==='p'?'paragraph':tag==='img'?`image${el.attr('alt')?` “${squash(el.attr('alt')!,40)}”`:''}`:container?'section':tag;
  // Containers are named by their first heading; leaves by their own text.
  const text=tag==='img'?'':squash((container?el.find('h1,h2,h3,h4').first().text():el.text()) || '',50);
  return `${label}${text?` “${text}”`:''}`;
 }
 read(id:string){const el=this.find(id);const html=this.$.html(el);return html.length>12000?html.slice(0,12000)+'… (truncated; read a child element for the rest)':html;}
 replace(id:string,html:string){const el=this.find(id),nodes=this.fragment(html);el.replaceWith(nodes);this.tag(nodes);return nodes.toArray().filter(n=>n.type==='tag').map(n=>this.$(n).attr('data-ai')).join(', ');}
 insert(id:string|null,position:string,html:string){
  const nodes=this.fragment(html);
  if(!id){position==='inside_start'?this.$.root().prepend(nodes):this.$.root().append(nodes);}
  else{
   const el=this.find(id);
   if(position==='before')el.before(nodes);else if(position==='after')el.after(nodes);
   else if(position==='inside_start'){if(['img','br','hr'].includes((el[0] as Element).name))throw new DocumentToolError(`<${(el[0] as Element).name}> cannot contain children; use before/after.`);el.prepend(nodes);}
   else if(position==='inside_end'){if(['img','br','hr'].includes((el[0] as Element).name))throw new DocumentToolError(`<${(el[0] as Element).name}> cannot contain children; use before/after.`);el.append(nodes);}
   else throw new DocumentToolError('position must be before, after, inside_start or inside_end');
  }
  this.tag(nodes);return nodes.toArray().filter(n=>n.type==='tag').map(n=>this.$(n).attr('data-ai')).join(', ');
 }
 remove(id:string){const el=this.find(id);el.remove();}
 update(id:string,change:{text?:string|null;styles?:Record<string,string>|null;attributes?:Record<string,string>|null}){
  const el=this.find(id),tag=(el[0] as Element).name,done:string[]=[];
  if(typeof change.text==='string'){
   if(el.find('table,td,div,p,h1,h2,h3,h4,img').length)throw new DocumentToolError(`${id} is a container. Set text on the specific heading/paragraph/link inside it, or use replace_element.`);
   el.text(change.text.slice(0,4000));done.push('text');
  }
  if(change.styles && Object.keys(change.styles).length){
   const current=new Map<string,string>();
   for(const part of (el.attr('style') || '').split(';')){const i=part.indexOf(':');if(i>0)current.set(part.slice(0,i).trim().toLowerCase(),part.slice(i+1).trim());}
   for(const [k,v] of Object.entries(change.styles)){const key=k.trim().toLowerCase().replace(/[A-Z]/g,m=>'-'+m.toLowerCase());if(!v)current.delete(key);else current.set(key,String(v));done.push(`${key}${v?`: ${v}`:' removed'}`);}
   const css=cleanCss([...current].map(([k,v])=>`${k}:${v}`).join(';'));css?el.attr('style',css):el.removeAttr('style');
   if(change.styles['background-color'] || change.styles.background){const bg=change.styles['background-color'] || change.styles.background;if(el.attr('bgcolor')!==undefined && /^#?[0-9a-f]{3,8}$|^[a-z]+$/i.test(bg!))el.attr('bgcolor',bg!);}
  }
  if(change.attributes){
   for(const [k,v] of Object.entries(change.attributes)){
    const key=k.toLowerCase();
    if(!ATTRS.has(key) || key==='data-ai' || key==='style' || key.startsWith('on'))throw new DocumentToolError(`Attribute ${k} is not allowed. Allowed: href, src, alt, title, width, height, align, valign, bgcolor, border, cellpadding, cellspacing, target, colspan, rowspan.`);
    if(!v){el.removeAttr(key);done.push(`${key} removed`);continue;}
    if(['href','src','background'].includes(key)){const url=safeUrl(/^[a-z][a-z0-9+.-]*:|^#|^{{/i.test(v)?v:`https://${v}`,key!=='href');if(!url)throw new DocumentToolError(`${v} is not a valid ${key} URL.`);el.attr(key,url);done.push(`${key}: ${url}`);}
    else{el.attr(key,v.slice(0,300));done.push(`${key}: ${v}`);}
   }
   if(tag==='a' && el.attr('target'))el.attr('rel','noopener noreferrer');
  }
  if(!done.length)throw new DocumentToolError('Nothing to update. Provide text, styles or attributes.');
  return done;
 }
 write(html:string){const nodes=this.fragment(html);this.$.root().empty().append(nodes);this.tag(this.$.root());}
}
