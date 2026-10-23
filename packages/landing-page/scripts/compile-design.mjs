import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseFragment} from 'parse5';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'components/generated');
const pages={Landing:'Valasys Mail Landing v16',SignIn:'Sign In',CreateAccount:'Create Account',Sales:'Talk to Sales'};
const routes={'Valasys Mail Landing v13.dc.html':'/','Valasys Mail Landing.dc.html':'/','Valasys Mail Landing v16.dc.html':'/','Sign In.dc.html':'/sign-in','Create Account.dc.html':'/create-account','Talk to Sales.dc.html':'/talk-to-sales'};
const json=JSON.stringify,inventory=[];
fs.mkdirSync(out,{recursive:true});
function routeStrings(value){for(const [file,route] of Object.entries(routes))value=value.replaceAll(file,route);return value.replaceAll("'assets/'","'/assets/'");}
for(const [name,file] of Object.entries(pages)){
 const source=fs.readFileSync(path.join(root,'design-reference',`${file}.dc.html`),'utf8'),logic=source.match(/<script\b[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/i)?.[1],template=source.match(/<x-dc\b[^>]*>([\s\S]*?)<\/x-dc>/i)?.[1];
 if(!logic || !template)throw new Error(`Missing design/logic: ${file}`);
 const helmet=template.match(/<helmet\b[^>]*>([\s\S]*?)<\/helmet>/i)?.[1] || '',css=[...helmet.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(match=>match[1]).join('\n');
 const attrNames=new Map([...template.matchAll(/\s([\w:-]+)\s*=/g)].map(match=>[match[1].toLowerCase(),match[1]]));
 let markup=template.replace(/<helmet\b[^>]*>[\s\S]*?<\/helmet>/i,'');
 for(const tag of ['select','table','tbody','thead','tfoot','tr','td','th','caption'])markup=markup.replace(new RegExp(`(</?)${tag}(?=[\\s>])`,'gi'),`$1ref-raw-${tag}`);
 const tree=parseFragment(markup),pseudo=[];let count=0,loops=0;
 function expr(raw,scope){const value=raw.trim();if(/^(true|false|null|undefined|-?\d+(\.\d+)?)$/.test(value))return value;if(/^[\w$]+(?:\.[\w$]+)*$/.test(value))return `${scope}?.${value.split('.').join('?.')}`;throw new Error(`Unsupported expression in ${file}: ${value}`);}
 function attr(value,scope){const whole=value.match(/^\s*\{\{([\s\S]*?)\}\}\s*$/);if(whole)return expr(whole[1],scope);if(!value.includes('{{'))return json(routeStrings(value));return value.split(/\{\{([\s\S]*?)\}\}/).map((part,i)=>i%2?`String(${expr(part,scope)} ?? '')`:json(routeStrings(part))).join(' + ');}
 function children(node,scope){return (node.childNodes || []).map((child,i)=>render(child,scope,i)).filter(Boolean).join(',');}
 function render(node,scope='v',index=0){
  if(node.nodeName==='#comment')return '';
  if(node.nodeName==='#text'){
   let parent=node.parentNode;while(parent?.tagName?.startsWith('sc-'))parent=parent.parentNode;
   if(!node.value.trim() && ['table','tbody','thead','tfoot','tr'].includes(parent?.tagName?.replace(/^ref-raw-/,'')))return '';
   if(!node.value.includes('{{'))return json(node.value);
   return `React.createElement(React.Fragment,{key:${index}},${node.value.split(/\{\{([\s\S]*?)\}\}/).map((part,i)=>i%2?`interpolate(${expr(part,scope)},${i})`:json(part)).join(',')})`;
  }
  const tag=node.tagName?.replace(/^ref-raw-/,'');if(!tag)return '';count++;
  const attrs=Object.fromEntries((node.attrs || []).map(a=>[a.name,a.value]));
  if(tag==='sc-if')return `(${attr(attrs.value || '',scope)} ? React.createElement(React.Fragment,{key:${index}},${children(node,scope)}) : null)`;
  if(tag==='sc-for'){const nested=`scope${++loops}`;return `asList(${attr(attrs.list || '',scope)}).map((item,$index)=>{const ${nested}={...${scope},${json(attrs.as || 'item')}:item,$index};return React.createElement(React.Fragment,{key:$index},${children(node,nested)});})`;}
  if(tag.startsWith('sc-'))throw new Error(`Unsupported tag ${tag}`);
  const props=[`key:${index}`],classes=[];
  if(tag==='form')props.push(`"aria-busy":!!this.state.busy`);
  if(tag==='button' && attrs.type==='submit')props.push(`disabled:!!this.state.busy`);
  if(tag==='input' && !attrs.id && attrs.placeholder)props.push(`"aria-label":${json(attrs.placeholder)}`);
  if(tag==='input' && attrs.id?.endsWith('-pass'))props.push('maxLength:200',...(name==='CreateAccount'?['minLength:8']:[]));
  for(const attribute of node.attrs || []){
   let key=attrNames.get(attribute.name) || attribute.name,value=attribute.value;
   if(key.startsWith('hint-'))continue;
   if(key.startsWith('style-')){const cls=`landing-${name.toLowerCase()}-${pseudo.length}`;pseudo.push(`.${cls}:${key.slice(6)}{${value.split(';').filter(s=>s.trim()).map(s=>s+' !important').join(';')}}`);classes.push(cls);continue;}
   if(key==='class')key='className';if(key==='for')key='htmlFor';
   const svgKeys={'stroke-width':'strokeWidth','stroke-linecap':'strokeLinecap','stroke-linejoin':'strokeLinejoin','fill-rule':'fillRule','clip-rule':'clipRule','tabindex':'tabIndex'};key=svgKeys[key] || key;
   if(key==='style'){props.push(`style:cssStyle(${attr(value,scope)})`);continue;}
   if(key==='src' && value.startsWith('assets/'))value='/'+value;
   const bool=['required','disabled','checked','multiple','autoFocus','readOnly'].includes(key);
   props.push(`${json(key)}:${bool && !value.includes('{{')?String(value!=='false'):attr(value,scope)}`);
  }
  if(classes.length){const at=props.findIndex(p=>p.startsWith('"className":'));if(at>=0)props[at]=`className:[${props[at].slice(12)},${json(classes.join(' '))}].filter(Boolean).join(' ')`;else props.push(`className:${json(classes.join(' '))}`);}
  const kids=children(node,scope);return `React.createElement(${json(tag)},{${props.join(',')}}${kids?','+kids:''})`;
 }
 const view=children(tree,'v'),controller=routeStrings(logic).replace('class Component extends DCLogic','class ReferenceController extends React.Component');
 const output=`// @ts-nocheck\n'use client';\n// Generated from immutable ${file}.dc.html by scripts/compile-design.mjs.\nimport React from 'react';\nimport {asList,cssStyle,interpolate} from '../runtime';\nimport {prepareController,Feedback} from '../site-actions';\n${controller}\nexport default class ${name} extends ReferenceController {\n constructor(props){super(props);prepareController(this,${json(name)});}\n render(){const v={...this.props,...this.renderVals()};return React.createElement(React.Fragment,null,React.createElement('style',null,${json((css+'\n'+pseudo.join('\n')).replaceAll("'Instrument Sans'","'Instrument Sans Variable'"))}),${view},React.createElement(Feedback,{controller:this}));}\n}\n`;
 fs.writeFileSync(path.join(out,`${name}.tsx`),output);
 inventory.push({page:name,reference:`${file}.dc.html`,sha256:crypto.createHash('sha256').update(source).digest('hex'),elements:count,collections:loops});
}
fs.writeFileSync(path.join(out,'inventory.json'),json(inventory,null,2)+'\n');console.log(inventory);
