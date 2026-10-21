/** DeepSeek Harness runtime for the Valasys email agent.
 * Each agent turn boots the published harness (`@deepseek-ai/dsh`, profile `valasys-agent`) in a
 * throwaway home: its agent loop, step scheduling, retry and context compaction drive the model,
 * and its MCP client calls the Valasys tools served by this worker. The child process gets a
 * minimal environment: no database, Redis, KMS or tenant credentials.
 */
import {mkdtemp,mkdir,copyFile,rm,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DeepSeekHarness,type RunResult} from '@deepseek-ai/dsh-sdk-client';
import {aiConfig,AiProviderUnavailableError,type AgentRuntime} from '@platform/shared';

const PROFILE='valasys-agent';
const profileSource=join(dirname(fileURLToPath(import.meta.url)),'..','harness');

async function harnessBin(){
 const require=createRequire(import.meta.url),manifest=require.resolve('@deepseek-ai/dsh/package.json');
 const bin=JSON.parse(await readFile(manifest,'utf8')).bin;
 return join(dirname(manifest),typeof bin==='string'?bin:bin.dsh);
}

function usage(result:RunResult){
 let input:number|null=0,output:number|null=0;
 for(const event of result.events as any[]){
  if(event?.type!=='assistant/message')continue;
  const u=event.data?.usage;
  input=input===null || typeof u?.inputTokens!=='number'?null:input+u.inputTokens;
  output=output===null || typeof u?.outputTokens!=='number'?null:output+u.outputTokens;
 }
 return {input,output};
}
/** A turn that ended in error (provider failure, configuration error). Only the error code is logged. */
function turnError(result:RunResult){
 const end=[...(result.events as any[])].reverse().find(event=>event?.type==='turn/end');
 return end?.data?.reason?.kind==='error'?String(end.data.reason.error?.code || 'UNKNOWN'):null;
}

export async function createHarnessRuntime():Promise<AgentRuntime>{
 const dshBin=await harnessBin();
 return {open:async({systemPrompt,toolUrl,token,signal})=>{
  const c=aiConfig();
  const home=await mkdtemp(join(tmpdir(),'valasys-agent-')),work=join(home,'work'),profile=join(home,'profiles',PROFILE);
  await mkdir(work,{recursive:true});await mkdir(profile,{recursive:true});
  for(const file of ['package.json','cordis.yml','cordis.patch.yml'])await copyFile(join(profileSource,file),join(profile,file));
  const harness=new DeepSeekHarness({
   dshBin,profile:PROFILE,dshHome:home,processCwd:work,cwd:work,provider:'valasys',model:c.model,maxTokens:c.maxOutputTokens,initializeTimeoutMs:30000,
   env:{PATH:process.env.PATH || '/usr/local/bin:/usr/bin:/bin',HOME:home,TMPDIR:home,NODE_ENV:'production',DSH_HOME:home,
    VALASYS_SYSTEM_PROMPT:systemPrompt,VALASYS_LLM_BASE_URL:`${c.baseUrl}/v1`,VALASYS_LLM_KEY:c.token || 'not-required',VALASYS_LLM_MODEL:c.model,
    VALASYS_LLM_CONTEXT:String(c.contextTokens),VALASYS_LLM_MAX_TOKENS:String(c.maxOutputTokens),VALASYS_MCP_URL:toolUrl,VALASYS_MCP_TOKEN:token,
    ...(process.env.HTTPS_PROXY?{HTTPS_PROXY:process.env.HTTPS_PROXY,NO_PROXY:'127.0.0.1,localhost'}:{})},
  });
  // The harness has no mid-turn cancel; stopping a run means ending its process.
  const stop=()=>void harness.close().catch(()=>undefined);
  signal.addEventListener('abort',stop,{once:true});
  const session=harness.session();
  let closed=false;
  return {
   send:async prompt=>{
    signal.throwIfAborted();
    let result:RunResult;
    try{result=await session.run(prompt);}
    catch{signal.throwIfAborted();throw new AiProviderUnavailableError();}
    signal.throwIfAborted();
    const error=turnError(result);
    if(error){console.warn('[valasys-ai] harness turn failed',{code:error});throw new AiProviderUnavailableError();}
    const {input,output}=usage(result);
    return {text:result.finalResponse,promptTokens:input,outputTokens:output};
   },
   close:async()=>{
    if(closed)return;closed=true;signal.removeEventListener('abort',stop);
    await harness.close().catch(()=>undefined);
    // Harness sessions are JSONL transcripts of customer content: never keep them past the turn.
    await rm(home,{recursive:true,force:true});
   },
  };
 }};
}
