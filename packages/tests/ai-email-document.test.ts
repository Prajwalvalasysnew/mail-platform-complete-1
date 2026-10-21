import {describe,expect,it} from 'vitest';
import {EmailDocument,sanitizeEmailHtml,linkPolicy,policyProblems,extractUserUrls,normalizeUrl,detachEditorHtml,AiInput} from '@platform/shared';

describe('AI email document tools',()=>{
 it('removes executable markup but keeps designed email HTML and inline styles',()=>{
  const clean=sanitizeEmailHtml('<table role="presentation" style="background-color:#f97316" onclick="x()"><tr><td><script>alert(1)</script><style>p{}</style><a href="javascript:alert(1)" target="_blank">Go</a><img src="data:image/png;base64,AA" alt="x"><form><input></form><p style="color:red;background:url(javascript:x);width:expression(1)">Hi</p><custom-tag>kept text</custom-tag></td></tr></table>');
  expect(clean).toContain('style="background-color:#f97316"');expect(clean).toContain('role="presentation"');
  for(const bad of ['onclick','<script','<style','javascript:','data:image','<form','<input','expression','url('])expect(clean).not.toContain(bad);
  expect(clean).toContain('style="color:red"');expect(clean).toContain('kept text');expect(clean).not.toContain('custom-tag');
  expect(clean).toContain('rel="noopener noreferrer"');
 });
 it('treats links the user typed, including bare domains, as approved and rejects invented ones',()=>{
  expect(extractUserUrls('use valasys.com or https://valasys.com/product, thanks')).toEqual(['https://valasys.com','https://valasys.com/product']);
  expect(normalizeUrl('HTTPS://Valasys.com/')).toBe('valasys.com');
  const policy=linkPolicy('add a button to valasys.com and email sales@valasys.com','<a href="https://existing.example/page">x</a>');
  expect(policyProblems('<a href="https://valasys.com/">a</a><a href="http://valasys.com">b</a><a href="https://existing.example/page">c</a><a href="#">d</a><a href="{{unsubscribe_url}}">e</a><a href="mailto:sales@valasys.com">f</a>',policy)).toEqual([]);
  expect(policyProblems('<a href="https://valasys.com/demo">x</a>',policy)[0]).toMatch(/was not provided by the user/);
  expect(policyProblems('<img src="https://images.example/hero.png">',policy)).toHaveLength(1);
  expect(policyProblems('Hi {{favourite_colour}}',policy)[0]).toMatch(/does not exist/);
 });
 it('edits one element in place and leaves everything else byte-identical',()=>{
  const html='<table role="presentation" style="background:#fff"><tbody><tr><td><h1 style="font-size:30px">Hello</h1><p>Body copy</p></td></tr></tbody></table>';
  const doc=new EmailDocument(html,'Subject');
  const view=doc.view();expect(view).toContain('data-ai="e1"');
  const h1=view.match(/<h1[^>]*data-ai="(e\d+)"/)![1]!,table=view.match(/<table[^>]*data-ai="(e\d+)"/)![1]!;
  expect(doc.update(table,{styles:{'background-color':'#f97316',background:''}})).toEqual(['background-color: #f97316','background removed']);
  doc.update(h1,{text:'Meet VAIS'});
  expect(doc.html()).toBe('<table role="presentation" style="background-color:#f97316"><tbody><tr><td><h1 style="font-size:30px">Meet VAIS</h1><p>Body copy</p></td></tr></tbody></table>');
  doc.insert(h1,'after','<p>New line</p>');expect(doc.html()).toContain('Meet VAIS</h1><p>New line</p><p>Body copy</p>');
  expect(()=>doc.update(table,{text:'flatten everything'})).toThrow(/container/);
  expect(()=>doc.update('e999',{text:'x'})).toThrow(/does not exist/);
  expect(()=>doc.update(h1,{attributes:{onclick:'x()'}})).toThrow(/not allowed/);
  expect(doc.text()).toContain('MEET VAIS');
 });
 it('summarizes large documents as an outline and recognizes the editor placeholder as blank',()=>{
  const big=new EmailDocument(`<table>${'<tr><td><p>Paragraph with plenty of copy for the outline.</p></td></tr>'.repeat(400)}</table>`);
  expect(big.view()).toMatch(/outline/);expect(big.view().length).toBeLessThan(12000);
  expect(new EmailDocument('<div class="email"><p>Add your email content here.</p></div>').isBlank()).toBe(true);
 });
 it('keeps canvas HTML out of the conversation budget',()=>{
  const input=AiInput.parse({operation:'editor',instruction:'Add a CTA',content:JSON.stringify({editor:{html:'<p>x</p>'.repeat(5000),preheader:'Pre',subject:'S'}})});
  const detached=detachEditorHtml(input);
  expect(detached.html?.length).toBe(40000);expect(detached.preheader).toBe('Pre');expect(detached.input.content).not.toContain('<p>');
  expect(()=>AiInput.parse({operation:'chat',instruction:'x',content:'x'.repeat(20000)})).toThrow(/too long/);
 });
});
