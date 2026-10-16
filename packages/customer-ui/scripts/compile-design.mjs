import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';

// Migration tool: emit ordinary React components at build time. The browser
// never parses a DC template, downloads Babel, or evaluates a script string.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = { Customer: 'Customer App', Email: 'Email Builder', Workflow: 'Workflow Builder', Agent: 'AI Agent' };
const links = { 'Customer App.dc.html': '/', 'Email Builder.dc.html': '/email-builder', 'Workflow Builder.dc.html': '/workflow-builder', 'AI Agent.dc.html': '/ai-agent' };
const out = path.join(root, 'src/faithful/generated');
fs.mkdirSync(out, { recursive: true });
const inventory = [];
const json = JSON.stringify;
function routeStrings(source) {
  for (const [file, route] of Object.entries(links)) source = source.replaceAll(file, route);
  return source;
}
for (const [name, file] of Object.entries(pages)) {
  const source = fs.readFileSync(path.join(root, 'design-reference', `${file}.dc.html`), 'utf8');
  const match = source.match(/<script\b[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error(`Missing interaction logic: ${file}`);
  const template = source.match(/<x-dc\b[^>]*>([\s\S]*?)<\/x-dc>/i)?.[1];
  if (!template) throw new Error(`Missing template: ${file}`);
  const helmet = template.match(/<helmet>([\s\S]*?)<\/helmet>/i)?.[1] || '';
  const css = [...helmet.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
  const attrNames = new Map([...template.matchAll(/\s([\w:-]+)\s*=/g)].map(m => [m[1].toLowerCase(), m[1]]));
  // HTML parsers otherwise foster-parent custom loops out of table/select
  // elements. Preserve the exported nesting before producing real React tags.
  const protectedTags = ['select','table','tbody','thead','tfoot','tr','td','th','caption'];
  let protectedTemplate = template.replace(/<helmet>[\s\S]*?<\/helmet>/i, '');
  for (const tag of protectedTags) protectedTemplate = protectedTemplate.replace(new RegExp(`(</?)${tag}(?=[\\s>])`,'gi'),`$1ref-raw-${tag}`);
  const tree = parseFragment(protectedTemplate);
  const pseudo = [];
  let nodes = 0, conditions = 0, loops = 0;
  const expressions = new Set();
  function expr(raw, scope = 'v') {
    const value = raw.trim(); expressions.add(value);
    if (/^(true|false|null|undefined|-?\d+(\.\d+)?)$/.test(value)) return value;
    if (/^[\w$]+(?:\.[\w$]+)*$/.test(value)) return `${scope}?.${value.split('.').join('?.')}`;
    throw new Error(`${file}: unsupported expression ${value}`);
  }
  function attr(value, scope) {
    const whole = value.match(/^\s*\{\{([\s\S]*?)\}\}\s*$/);
    if (whole) return expr(whole[1], scope);
    if (!value.includes('{{')) return json(routeStrings(value));
    return value.split(/\{\{([\s\S]*?)\}\}/).map((p,i) => i%2 ? `String(${expr(p,scope)} ?? '')` : json(routeStrings(p))).join(' + ');
  }
  function render(node, scope = 'v', index = 0) {
    if (node.nodeName === '#comment') return '';
    if (node.nodeName === '#text') {
      // Formatting indentation is not a valid React table child. Walk past
      // template-only wrappers to find the actual native parent.
      let parent=node.parentNode;
      while(parent?.tagName?.startsWith('sc-'))parent=parent.parentNode;
      if(!node.value.trim() && ['table','thead','tbody','tfoot','tr','colgroup'].includes(parent?.tagName?.replace(/^ref-raw-/,'')))return '';
      if (!node.value.includes('{{')) return !node.value.trim() && !node.value.includes(' ') ? '' : `referenceText(${json(node.value)},controller.props.textOverrides)`;
      return `React.createElement(React.Fragment,{key:${index}},${node.value.split(/\{\{([\s\S]*?)\}\}/).map((p,i) => i%2 ? `interpolate(${expr(p,scope)},${i})` : `referenceText(${json(p)},controller.props.textOverrides)`).join(',')})`;
    }
    const tag = node.tagName?.replace(/^ref-raw-/,'');
    if (!tag) return '';
    nodes++;
    const attributes = Object.fromEntries((node.attrs || []).map(a => [a.name,a.value]));
    if (tag === 'sc-if') {
      conditions++;
      return `(${attr(attributes.value || '',scope)} ? React.createElement(React.Fragment,{key:${index}},${children(node,scope)}) : null)`;
    }
    if (tag === 'sc-for') {
      loops++;
      const alias = attributes.as || 'item';
      const nested = `scope${loops}`;
      return `asList(${attr(attributes.list || '',scope)}).map((item,$index)=>{const ${nested}={...${scope},${json(alias)}:item,$index};return React.createElement(React.Fragment,{key:$index},${children(node,nested)});})`;
    }
    if (tag.startsWith('sc-') || tag === 'x-import' || tag === 'dc-import') throw new Error(`Unhandled tag ${tag}`);
    const props = [`key:${index}`];
    const classes = [];
    for (const a of node.attrs || []) {
      let key = attrNames.get(a.name) || a.name;
      if (key.startsWith('hint-')) continue;
      if (key.startsWith('style-')) {
        if (a.value.includes('{{')) continue; // The exported runtime also treats pseudo rules as static CSS.
        const cls = `ref-${name.toLowerCase()}-${pseudo.length}`;
        const important = a.value.split(';').filter(x=>x.trim()).map(x=>`${x.replace(/\s*!important\s*$/,'')} !important`).join(';');
        pseudo.push(`.${cls}:${key.slice(6)}{${important}}`); classes.push(cls); continue;
      }
      if (key === 'class') key = 'className';
      if (key === 'for') key = 'htmlFor';
      if (key === 'style') { props.push(`style:cssStyle(${attr(a.value,scope)})`); continue; }
      if (key === 'className') { classes.push(null); props.push(`className:${attr(a.value,scope)}`); continue; }
      const bool = ['disabled','checked','selected','multiple','required','autoFocus','readOnly','hidden'].includes(key);
      const value = bool && !a.value.includes('{{') ? String(a.value !== 'false') : attr(a.value,scope);
      props.push(`${json(key)}:${value}`);
    }
    const staticClasses = classes.filter(Boolean).join(' ');
    if (staticClasses) {
      const classProp = props.findIndex(x=>x.startsWith('className:'));
      if (classProp >= 0) props[classProp] = `className:[${props[classProp].slice(10)},${json(staticClasses)}].filter(Boolean).join(' ')`;
      else props.push(`className:${json(staticClasses)}`);
    }
    let kids = children(node,scope);
    // Keep the comparison export unchanged, but let the live adapter replace
    // its static example sender choices with tenant-owned verified domains.
    if(name==='Customer' && tag==='select' && attributes.value?.trim()==='{{ cdFromEmail }}')kids=`(${scope}?.cdSenders ? asList(${scope}.cdSenders).map(sender=>React.createElement('option',{key:sender.value,value:sender.value},sender.label)) : React.createElement(React.Fragment,null,${kids}))`;
    return `React.createElement(${json(tag)},{${props.join(',')}}${kids ? ','+kids : ''})`;
  }
  function children(node,scope) { return (node.childNodes || []).map((n,i)=>render(n,scope,i)).filter(Boolean).join(','); }
  const view = children(tree,'v');
  const interactionSource = routeStrings(match[1]).replace('class Component extends DCLogic', 'class ReferenceController extends DesignState');
  const output = `// @ts-nocheck\n// Generated from ${file}.dc.html. Run npm run design:compile to regenerate.\nimport React from 'react';\nimport { DesignState, cssStyle, interpolate, asList, referenceText, type DesignValues } from '../runtime';\n${interactionSource}\nexport const DesignController: new (props: DesignValues) => DesignState = ReferenceController;\nexport const referenceCss: string=${json(css+'\n'+pseudo.join('\n'))};\nexport function ReferenceView({controller}: {controller: DesignState}): React.ReactElement {const v={...controller.props,...controller.renderVals()};return React.createElement(React.Fragment,null,${view});}\n`;
  fs.writeFileSync(path.join(out, `${name}.tsx`), output);
  inventory.push({ component: name, reference: `${file}.dc.html`, sha256: crypto.createHash('sha256').update(source).digest('hex'), elements:nodes, conditions, loops, bindings:expressions.size });
}
fs.writeFileSync(path.join(out,'inventory.json'),json(inventory,null,2)+'\n');
console.log(inventory.map(p=>`${p.component}: ${p.elements} elements, ${p.conditions} states, ${p.loops} collections, ${p.bindings} bindings`).join('\n'));
