// Run with: node --env-file=.env scripts/ai-smoke.mjs
// Sends fixed synthetic text only; never prints credentials or raw provider errors.
import shared from '../packages/shared/dist/index.js';
const {AiInput,generateAi,closeQueues,closeDb,closeRedis}=shared;
let failed=false;
try{
  for(const request of [
    {operation:'compact',content:JSON.stringify({previous_checkpoint:'',turns:[{messages:[{role:'user',content:'Remember the synthetic project codename ORCHID-731 and use a plain tone.'},{role:'assistant',content:'I will use ORCHID-731 as the codename and keep the tone plain.'}]}]}),instruction:'Create a concise checkpoint preserving the codename and tone, under 1400 UTF-8 bytes.'},
    {operation:'chat',content:'',instruction:'Synthetic test: explain how to write a clear email subject in two sentences.'},
    {operation:'subjects',content:'Synthetic product announcement: a redesigned dashboard.',instruction:''},
    {operation:'rewrite',content:'Hello {{first_name}}, our dashboard update is now available.',instruction:'Make it shorter.'},
    {operation:'draft',content:'',instruction:'Synthetic test: announce a redesigned dashboard. No discounts or deadlines. No links. Use a heading and a paragraph.'},
  ]){
    const start=Date.now();
    try{
      const response=await generateAi(AiInput.parse(request),new AbortController().signal);
      console.log(JSON.stringify({operation:request.operation,status:'passed',duration_ms:Date.now()-start,prompt_tokens:response.promptTokens,output_tokens:response.outputTokens}));
    }catch(error){failed=true;console.error(JSON.stringify({operation:request.operation,status:'failed',duration_ms:Date.now()-start,error_type:error.name,reason:['Incomplete inference','Inference unavailable','AI disabled'].includes(error.message)?error.message:'Validation or connection failed',validation:error.issues?.map(i=>({path:i.path,code:i.code})),connection_code:error.cause?.code}));}
  }
}finally{
  await closeQueues();await closeRedis().catch(()=>undefined);await closeDb();
}
if(failed)process.exitCode=1;
