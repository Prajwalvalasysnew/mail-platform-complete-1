import {afterEach,describe,expect,it,vi} from 'vitest';
import {AiInput,aiConfig,validateAiOutput,generateAi,ReadCall,estimateAiEnvelope} from '@platform/shared';

afterEach(()=>vi.unstubAllEnvs());
const input=(operation:'subjects'|'rewrite'|'draft'|'chat',extra:Record<string,string>={})=>AiInput.parse({operation,content:'Hello {{first_name}}, read our update.',instruction:'Announce a dashboard update.',...extra});
function configured(){vi.stubEnv('AI_ENABLED','true');vi.stubEnv('AI_BASE_URL','https://inference.test');vi.stubEnv('AI_MODEL','fixture-model');}
function response(value:unknown,other:Record<string,unknown>={}){return new Response(JSON.stringify({done:true,done_reason:'stop',message:{content:JSON.stringify(value)},...other}));}

describe('AI writing content and transport',()=>{
  it('validates bounded conversational output without executable markup rendering',()=>{
    const request=AiInput.parse({operation:'chat',instruction:'How do I write a subject?'});
    expect(validateAiOutput(request,{text:'Keep it clear.'})).toEqual({operation:'chat',text:'Keep it clear.'});
    expect(()=>validateAiOutput(request,{text:'x'.repeat(12001)})).toThrow();
    expect(()=>validateAiOutput(request,{text:'Ready',tool:'send'})).toThrow();
  });
  it('uses the harness text-density estimator for telemetry and strictly validates read tools',()=>{
    expect(estimateAiEnvelope([{role:'system',content:'12345678'},{role:'user',content:'1234'}])).toBe(15);
    expect(()=>ReadCall.parse({tool:'execute_sql',query:'delete all'})).toThrow();
    expect(()=>ReadCall.parse({tool:'read_template',id:null})).toThrow();
    expect(()=>ReadCall.parse({tool:'search_history',query:'x'})).toThrow();
    expect(()=>ReadCall.parse({tool:'delivery_summary',days:365})).toThrow();
  });
  it('retries one explicit temporary provider rejection within the same deadline',async()=>{
    configured();const fetcher=vi.fn().mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(response({text:'Clear copy.'},{prompt_eval_count:10,eval_count:3}));
    expect((await generateAi(input('chat'),new AbortController().signal,fetcher)).result).toEqual({operation:'chat',text:'Clear copy.'});expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('requires explicit permission for a cloud-tagged model and refuses credential-bearing URLs',()=>{
    expect(()=>aiConfig({AI_ENABLED:'true',AI_BASE_URL:'https://inference.test',AI_MODEL:'gpt-oss:120b-cloud'})).toThrow(/Cloud/);
    expect(()=>aiConfig({AI_ENABLED:'true',AI_BASE_URL:'https://secret:password@inference.test'})).toThrow(/Invalid/);
    expect(()=>aiConfig({AI_ENABLED:'true',AI_BASE_URL:'https://inference.test',AI_CONTEXT_TOKENS:'2000'})).toThrow(/reserve/);
  });
  it('rejects unknown request fields and missing rewrite content',()=>{
    expect(()=>AiInput.parse({operation:'rewrite',content:'',model:'untrusted'})).toThrow();
    expect(()=>AiInput.parse({operation:'draft',instruction:''})).toThrow();
  });
  it('preserves exact merge tags and bounds rewrite expansion',()=>{
    expect(validateAiOutput(input('rewrite'),{text:'Welcome {{first_name}}.'})).toMatchObject({operation:'rewrite'});
    expect(()=>validateAiOutput(input('rewrite'),{text:'Welcome {{last_name}}.'})).toThrow(/Merge tags/);
    expect(()=>validateAiOutput(input('rewrite'),{text:'Hello {{first_name}}, see https://invented.example.test'})).toThrow(/supplied links/);
    expect(()=>validateAiOutput(input('rewrite'),{text:'x'.repeat(1000)+'{{first_name}}'})).toThrow(/long/);
  });
  it('rejects multiline and duplicate subjects',()=>{
    expect(()=>validateAiOutput(input('subjects'),{subjects:['First','First','Third']})).toThrow();
    expect(()=>validateAiOutput(input('subjects'),{subjects:['First\nInjected: yes','Second','Third']})).toThrow();
  });
  it('renders model text as text and only permits links supplied in the brief',()=>{
    const draft={subject:'Update',preheader:'Preview',blocks:[{type:'paragraph',text:'<script>alert(1)</script>',url:''}]};
    const out=validateAiOutput(input('draft'),draft);
    expect(out.operation==='draft' && out.html).toContain('&lt;script&gt;');
    expect(out.operation==='draft' && out.html).not.toContain('<script>');
    const button={...draft,blocks:[{type:'button',text:'Read more',url:'https://example.test/update'}]};
    expect(()=>validateAiOutput(input('draft'),button)).toThrow(/supplied/);
    expect(validateAiOutput(input('draft',{instruction:'Use https://example.test/update'}),button).operation).toBe('draft');
    expect(()=>validateAiOutput(input('draft'),{...button,blocks:[{type:'button',text:'Go',url:'javascript:alert(1)'}]})).toThrow();
  });
  it('renders a styled email composition and validates conversational answers without inventing merge tags',()=>{
    const request=AiInput.parse({operation:'editor',instruction:'Create a professional product demo template.'});
    const value={reply:'A product demo email is ready.',draft:{subject:'Explore the product demo',preheader:'Take a closer look',design:{theme:'ocean',layout:'showcase',eyebrow:'PRODUCT DEMO',footer:''},blocks:[{type:'heading',text:'See the product in action',url:''},{type:'feature',text:'Explore the demo at your own pace.',url:''}]}};
    const result=validateAiOutput(request,value);expect(result.operation).toBe('draft');if(result.operation==='draft'){expect(result.html).toContain('role="presentation"');expect(result.html).toContain('#0369a1');expect(result.html).toContain('<h1');expect(result.html).not.toContain('href=');}
    expect(validateAiOutput(request,{reply:'Who should this email address?',draft:null})).toEqual({operation:'chat',text:'Who should this email address?'});
    expect(()=>validateAiOutput({...request,instruction:'Explain this layout; do not change the email.'},value)).toThrow(/forbids editing/);
    expect(()=>validateAiOutput(request,{...value,draft:{...value.draft,blocks:[{type:'paragraph',text:'Dear {{invented_name}}',url:''}]}})).toThrow(/merge tags/);
  });
  it('normalizes successful output without provider details and does not invent missing usage',async()=>{
    configured();const fetcher=vi.fn(async()=>response({subjects:['A useful update','New dashboard','See what changed']}));
    const result=await generateAi(input('subjects'),new AbortController().signal,fetcher);
    expect(result.result.operation).toBe('subjects');expect(result.promptTokens).toBeNull();
    const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('https://inference.test/api/chat');expect(options.redirect).toBe('error');
    expect(JSON.parse(options.body as string)).toMatchObject({model:'fixture-model',stream:false,think:'low'});
  });
  it('refuses token exhaustion, malformed JSON, unsuccessful responses and oversized bodies',async()=>{
    configured();const signal=new AbortController().signal;
    for(const body of [response({subjects:['A','B','C']},{done_reason:'length'}),response({subjects:['A','B','C']},{done:false}),new Response('secret upstream error',{status:502}),new Response('x'.repeat(256001))]){
      await expect(generateAi(input('subjects'),signal,async()=>body)).rejects.toThrow();
    }
  });
  it('makes one bounded schema correction and sums both attempts without exposing invalid content',async()=>{
    configured();const fetcher=vi.fn().mockResolvedValueOnce(response({wrong:'field'},{prompt_eval_count:10,eval_count:5}))
      .mockResolvedValueOnce(response({text:'Welcome {{first_name}}.'},{prompt_eval_count:30,eval_count:8}));
    const out=await generateAi(input('rewrite'),new AbortController().signal,fetcher);
    expect(out).toMatchObject({promptTokens:40,outputTokens:13,result:{operation:'rewrite',text:'Welcome {{first_name}}.'}});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
