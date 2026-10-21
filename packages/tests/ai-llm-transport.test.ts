import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {chatWithTools,AiContextOverflowError,AiProviderUnavailableError,AiOutputValidationError,type AgentMessage} from '@platform/shared';

const json=(body:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
const tools=[{name:'view_email',description:'Show the email',parameters:{type:'object',properties:{}}}];
const history:AgentMessage[]=[
 {role:'system',content:'You edit emails.'},{role:'user',content:'Make it orange'},
 {role:'assistant',content:'',thinking:'Look first',tool_calls:[{id:'c1',name:'view_email',arguments:{}}]},
 {role:'tool',tool_call_id:'c1',name:'view_email',content:'<p>Hi</p>'},
];
const signal=()=>new AbortController().signal;
const body=(fetcher:ReturnType<typeof vi.fn>,call=0)=>JSON.parse((fetcher.mock.calls[call] as any)[1].body);

beforeEach(()=>{vi.stubEnv('AI_ENABLED','true');vi.stubEnv('AI_BASE_URL','https://inference.test');vi.stubEnv('AI_MODEL','fixture-model');vi.stubEnv('AI_GATEWAY_TOKEN','secret');});
afterEach(()=>vi.unstubAllEnvs());

describe('agent tool-calling transport',()=>{
 it('speaks the Ollama dialect: tools, prior tool calls and usage',async()=>{
  const fetcher=vi.fn(async()=>json({done:true,done_reason:'stop',message:{content:'Done',thinking:'ok',tool_calls:[{function:{name:'view_email',arguments:{}}},{function:{name:'set_subject',arguments:'{"subject":"Hi"}'}}]},prompt_eval_count:120,eval_count:30}));
  const reply=await chatWithTools(history,tools,signal(),fetcher as any,500);
  expect(fetcher.mock.calls[0]![0]).toBe('https://inference.test/api/chat');
  const sent=body(fetcher);
  expect(sent).toMatchObject({model:'fixture-model',stream:false,options:{num_predict:500}});
  expect(sent.tools[0].function.name).toBe('view_email');
  expect(sent.messages[2]).toMatchObject({role:'assistant',thinking:'Look first',tool_calls:[{function:{name:'view_email'}}]});
  expect(sent.messages[3]).toEqual({role:'tool',tool_name:'view_email',content:'<p>Hi</p>'});
  expect((fetcher.mock.calls[0] as any)[1].headers.Authorization).toBe('Bearer secret');
  expect(reply).toMatchObject({content:'Done',thinking:'ok',promptTokens:120,outputTokens:30});
  expect(reply.toolCalls).toEqual([{id:'call_0',name:'view_email',arguments:{}},{id:'call_1',name:'set_subject',arguments:{subject:'Hi'}}]);
 });
 it('speaks the OpenAI dialect and requests JSON mode without tools',async()=>{
  vi.stubEnv('AI_PROVIDER','openai');
  const fetcher=vi.fn(async()=>json({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'t9',function:{name:'view_email',arguments:'not json'}}]}}],usage:{prompt_tokens:10,completion_tokens:-1}}));
  const reply=await chatWithTools(history,tools,signal(),fetcher as any);
  expect(fetcher.mock.calls[0]![0]).toBe('https://inference.test/v1/chat/completions');
  const sent=body(fetcher);
  expect(sent.messages[2]).toMatchObject({role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'view_email',arguments:'{}'}}]});
  expect(sent.messages[3]).toEqual({role:'tool',tool_call_id:'c1',content:'<p>Hi</p>'});
  expect(reply).toMatchObject({content:'',promptTokens:10,outputTokens:null,toolCalls:[{id:'t9',name:'view_email',arguments:'not json'}]});
  await chatWithTools([{role:'user',content:'Return JSON'}],[],signal(),fetcher as any);
  expect(body(fetcher,1).response_format).toEqual({type:'json_object'});
 });
 it('retries one transient failure, honouring Retry-After',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(json({error:'busy'},503,{'retry-after':'0.01'})).mockResolvedValueOnce(json({done:true,done_reason:'stop',message:{content:'ok'}}));
  expect((await chatWithTools(history,[],signal(),fetcher as any)).content).toBe('ok');
  expect(fetcher).toHaveBeenCalledTimes(2);
  const network=vi.fn().mockRejectedValueOnce(new Error('reset')).mockResolvedValueOnce(json({done:true,done_reason:'stop',message:{content:'again'}}));
  expect((await chatWithTools(history,[],signal(),network as any)).content).toBe('again');
 });
 it('never leaks upstream errors and classifies context overflow and truncation',async()=>{
  await expect(chatWithTools(history,[],signal(),vi.fn(async()=>json({error:'secret upstream detail'},500)) as any)).rejects.toBeInstanceOf(AiProviderUnavailableError);
  await expect(chatWithTools(history,[],signal(),vi.fn(async()=>json({error:'nope'},401)) as any)).rejects.toBeInstanceOf(AiProviderUnavailableError);
  await expect(chatWithTools(history,[],signal(),vi.fn(async()=>{throw new Error('down');}) as any)).rejects.toBeInstanceOf(AiProviderUnavailableError);
  await expect(chatWithTools(history,[],signal(),vi.fn(async()=>json({error:'prompt exceeds the context window'},400)) as any)).rejects.toBeInstanceOf(AiContextOverflowError);
  await expect(chatWithTools(history,[],signal(),vi.fn(async()=>json({error:'bad request'},400)) as any)).rejects.toBeInstanceOf(AiProviderUnavailableError);
  await expect(chatWithTools(history,[],signal(),vi.fn(async()=>json({done:true,done_reason:'length',message:{content:'cut'}})) as any)).rejects.toBeInstanceOf(AiOutputValidationError);
  await expect(chatWithTools(history,[],signal(),vi.fn(async()=>json({done:false})) as any)).rejects.toBeInstanceOf(AiOutputValidationError);
  vi.stubEnv('AI_PROVIDER','openai');
  await expect(chatWithTools(history,[],signal(),vi.fn(async()=>json({choices:[]})) as any)).rejects.toBeInstanceOf(AiOutputValidationError);
  await expect(chatWithTools(history,[],signal(),vi.fn(async()=>json({choices:[{finish_reason:'length',message:{content:'cut'}}]})) as any)).rejects.toBeInstanceOf(AiOutputValidationError);
 });
 it('refuses to run when AI is disabled',async()=>{
  vi.stubEnv('AI_ENABLED','false');
  await expect(chatWithTools(history,[],signal(),vi.fn() as any)).rejects.toThrow('AI disabled');
 });
});
