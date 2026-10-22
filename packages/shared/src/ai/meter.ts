/** Adapted from dsh-token-meter/src/estimate.ts (MIT; third_party/harness/LICENSE).
 * Text-density telemetry, not an exact tokenizer or admission authority.
 */
export function estimateAiEnvelope(messages:readonly {role:string;content:string}[],schema?:unknown){
 return messages.reduce((sum,message)=>sum+Math.ceil(message.content.length/4)+4+(message.role==='system'?0:4),0)+(schema?Math.ceil(JSON.stringify(schema).length/4)+4:0);
}
