import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {composeEmail,EmailDocument,linkPolicy,policyProblems,sanitizeEmailHtml,validateAiOutput,AiInput,toolsFor,missingEmailCopy} from '@platform/shared';

const newsletter=JSON.parse(readFileSync(new URL('./fixtures/valasys-newsletter.json',import.meta.url),'utf8'));
const reference=readFileSync(new URL('./fixtures/valasys-newsletter.html',import.meta.url),'utf8');
const policy=linkPolicy('Create a newsletter like this reference using https://valasys.com/',reference);

describe('AI newsletter design from the supplied HTML reference',()=>{
 it('detects missing explicitly requested headings and action labels, including hidden-only copy',()=>{
  const brief='Use heading "A brighter tomorrow", an "Our Services" section, and "Contact Our Team" button.';
  expect(missingEmailCopy(brief,'<h1>A brighter tomorrow</h1><p>Services below</p><a>Contact Our Team</a>')).toEqual(['Our Services']);
  expect(missingEmailCopy(brief,'<h1>A brighter tomorrow</h1><h2>Our Services</h2><a>Contact Our Team</a>')).toEqual([]);
  expect(missingEmailCopy('Use heading "Our Services"','<div style="display:none">Our Services</div><p>Hello</p>')).toEqual(['Our Services']);
  expect(missingEmailCopy('Remove the heading "Our Services"','<p>Hello</p>')).toEqual([]);
 });
 it('routes a new newsletter to the tested layout while allowing custom designs and existing references',()=>{
  const doc=new EmailDocument('<p>Add your email content here.</p>');
  const names=(userText:string,canvas=doc)=>toolsFor({mode:'editor',doc:canvas,userText}).map(tool=>tool.name);
  expect(names('Create a B2B newsletter with four service cards')).toContain('compose_email');
  expect(names('Create a B2B newsletter with four service cards')).not.toContain('write_email');
  expect(names('Create a custom three-column newsletter')).toContain('write_email');
  expect(names('Match this newsletter reference',new EmailDocument(reference))).toContain('write_email');
  expect(names('Create an order confirmation')).toContain('write_email');
 });
 it('rejects an incomplete composition before changing the canvas, then accepts the corrected draft',()=>{
  const doc=new EmailDocument('<p>Add your email content here.</p>');
  const ws={mode:'editor',doc,policy,changes:[],section:false,userText:'Create a newsletter with an "Our Services" section.'} as any;
  const tool=toolsFor(ws).find(tool=>tool.name==='compose_email')!;
  expect(()=>tool.run(ws,{...newsletter,blocks:newsletter.blocks.filter((block:any)=>block.text!=='Our Services')})).toThrow(/Our Services/);
  expect(doc.isBlank()).toBe(true);expect(ws.changes).toEqual([]);
  tool.run(ws,newsletter);expect(doc.html()).toContain('Our Services');expect(ws.changes).toHaveLength(1);
 });
 it('uses the sole supplied website when the user requests a website link in the footer',()=>{
  const doc=new EmailDocument('<p>Add your email content here.</p>'),design={...newsletter.design};delete design.websiteUrl;
  const ws={mode:'editor',doc,policy,changes:[],section:false,userText:'Create a newsletter linking to https://valasys.com/ with a footer with website and unsubscribe links.'} as any;
  toolsFor(ws).find(tool=>tool.name==='compose_email')!.run(ws,{...newsletter,design});
  expect(doc.html()).toContain('Visit our website</a>');
 });
 it('renders the full composition through the same compose tool used by the AI editor',()=>{
  const result=composeEmail(newsletter,policy);
  for(const title of ['Valasys Media','Smarter Marketing for a Brighter Tomorrow','Our Services','Email Campaigns','Audience Segments','Analytics','Marketing Support','Ready to Get Started?','Contact Our Team']){
   expect(reference).toContain(title);expect(result.html).toContain(title);expect(result.text).toContain(title);
  }
  expect(result.html).toContain('max-width:600px');expect(result.html).toContain('background-color:#102e59');
  expect(result.html.match(/<td width="50%" valign="top"/g)).toHaveLength(4);
  expect(result.html).toContain('href="{{unsubscribe_url}}"');
  expect(result.html.match(/href="https:\/\/valasys.com\/"/g)).toHaveLength(3);
  // The primary copy and CTA stay inside the hero band, not separate white rows.
  expect(result.html).toMatch(/<h1[^]*?Explore Our Solutions<\/a><\/td><\/tr><\/table><\/td><\/tr>/);
  expect(policyProblems(result.html,policy)).toEqual([]);
 });
 it('keeps the design through sanitization, targeted AI edits and a saved-document round trip',()=>{
  const result=composeEmail(newsletter,policy),doc=new EmailDocument(result.html,result.subject,result.preheader);
  const id=doc.view().match(/<h1[^>]*data-ai="(e\d+)"/)![1]!;
  doc.update(id,{text:'A clearer marketing strategy'});
  const saved=JSON.parse(JSON.stringify({html:doc.html(),design:result.design,subject:doc.subject}));
  const restored=new EmailDocument(saved.html,saved.subject);
  expect(restored.html()).toContain('A clearer marketing strategy');
  expect(restored.html().match(/width="50%" valign="top"/g)).toHaveLength(4);
  expect(restored.html()).toContain('background-color:#102e59');expect(restored.html()).toContain('{{unsubscribe_url}}');
  expect(sanitizeEmailHtml(reference)).toContain('Smarter Marketing');
 });
 it('supports the same newsletter structure in the validated JSON provider path',()=>{
  const out=validateAiOutput(AiInput.parse({operation:'draft',instruction:'Create this Valasys Media newsletter using https://valasys.com/',content:reference}),newsletter);
  expect(out.operation).toBe('draft');if(out.operation==='draft'){
   expect(out.html).toContain('Email Campaigns');expect(out.html).toContain('width="50%"');expect(out.design).toMatchObject({layout:'newsletter',brandName:'Valasys Media'});
  }
 });
 it('still rejects invented CTA/footer links, unsafe colours and executable card copy',()=>{
  expect(()=>composeEmail({...newsletter,design:{...newsletter.design,websiteUrl:'https://invented.example/'}},policy)).toThrow(/not provided/);
  expect(()=>composeEmail({...newsletter,blocks:[...newsletter.blocks.slice(0,-1),{...newsletter.blocks.at(-1),url:'javascript:alert(1)'}]},policy)).toThrow();
  expect(()=>composeEmail({...newsletter,design:{...newsletter.design,footerBackground:'red;position:fixed'}},policy)).toThrow();
  const safe=composeEmail({...newsletter,blocks:[{type:'heading',text:'Hello'},{type:'feature',title:'<script>alert(1)</script>',text:'<img src=x onerror=alert(1)>'}]},policy);
  expect(safe.html).not.toContain('<script>');expect(safe.html).not.toContain('<img src=x');expect(safe.html).toContain('&lt;script&gt;');
 });
 it('supports odd card counts without dropping the last service',()=>{
  const result=composeEmail({...newsletter,blocks:newsletter.blocks.filter((block:any)=>block.title!=='Marketing Support')},policy);
  expect(result.html.match(/<td width="50%" valign="top"/g)).toHaveLength(3);expect(result.html).toContain('Analytics');expect(result.html).toContain('<td width="50%" style="width:50%"></td>');
 });
 it('keeps brand labels in the header and groups a legacy closing CTA into one shaded band',()=>{
  const result=composeEmail({...newsletter,design:{...newsletter.design,tagline:'',eyebrow:''},blocks:[{type:'heading',text:'STAY AHEAD\nA brighter tomorrow'},...newsletter.blocks.slice(1,-1),{type:'heading',text:'B2B Marketing. Smarter.'},{type:'heading',text:'Ready to Get Started?'},{type:'paragraph',text:'Talk to our team.'},{type:'button',text:'Contact Our Team',url:'https://valasys.com/'}]},policy,{},'Use tagline "B2B Marketing. Smarter." and eyebrow STAY AHEAD, heading "A brighter tomorrow".');
  expect(result.html).toContain('letter-spacing:2px">STAY AHEAD</p>');
  expect(result.html).not.toContain('<h2 style="margin:0 0 10px;color:#123a70;font:700 25px/31px Arial,Helvetica,sans-serif">B2B Marketing. Smarter.');
  expect(result.html).toMatch(/background-color:#[a-f0-9]+"><h2[^]*?Ready to Get Started\?[^]*?Contact Our Team/);
  expect(result.design).toMatchObject({tagline:'B2B Marketing. Smarter.',eyebrow:'STAY AHEAD'});
 });
});
