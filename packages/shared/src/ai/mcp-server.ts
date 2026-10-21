/** Loopback MCP (Streamable HTTP, JSON responses) endpoint serving AGENT_TOOLS to the harness runtime.
 * Each run gets an unguessable bearer token bound to its own workspace; the harness process never
 * receives database or tenant credentials.
 */
import {createServer,type Server} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {toolsFor,runAgentTool,type AgentWorkspace} from './email-tools.js';

const SERVER_INSTRUCTIONS='Valasys workspace tools. Email element ids come from the data-ai attributes shown by view_email; workflow step ids come from view_workflow. Edits apply to the user\'s draft immediately; tool errors explain how to correct the call.';
export type AgentToolServer={url:string;register:(ws:AgentWorkspace)=>string;unregister:(token:string)=>void;close:()=>Promise<void>};

export async function startAgentToolServer():Promise<AgentToolServer>{
 const sessions=new Map<string,AgentWorkspace>();
 const lookup=(header:string|undefined)=>{
  const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(header || '')?.[1];if(!token)return undefined;
  for(const [key,ws] of sessions)if(timingSafeEqual(Buffer.from(key),Buffer.from(token)))return ws;
  return undefined;
 };
 const server:Server=createServer((req,res)=>{
  const ws=req.url==='/mcp'?lookup(req.headers.authorization):undefined;
  if(!ws){res.writeHead(401).end();return;}
  if(req.method==='DELETE'){res.writeHead(200).end();return;}
  if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'}).end();return;}
  const chunks:Buffer[]=[];let size=0;
  req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>400_000){res.writeHead(413).end();req.destroy();return;}chunks.push(chunk);});
  req.on('end',()=>void (async()=>{
   if(res.headersSent)return;
   let message:any;try{message=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{res.writeHead(400).end();return;}
   if(message?.id===undefined || message?.id===null){res.writeHead(202).end();return;}
   const reply=(body:Record<string,unknown>)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,...body}));};
   try{
    switch(message.method){
     case 'initialize':return reply({result:{protocolVersion:typeof message.params?.protocolVersion==='string'?message.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'valasys',version:'1.0.0'},instructions:SERVER_INSTRUCTIONS}});
     case 'ping':return reply({result:{}});
     case 'tools/list':return reply({result:{tools:toolsFor(ws).map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema}))}});
     case 'tools/call':{
      const outcome=await runAgentTool(ws,String(message.params?.name || ''),message.params?.arguments ?? {});
      return reply({result:{content:[{type:'text',text:outcome.text}],isError:outcome.isError}});
     }
     default:return reply({error:{code:-32601,message:'Method not found'}});
    }
   }catch{return reply({result:{content:[{type:'text',text:'This request was stopped.'}],isError:true}});}
  })());
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
 const address=server.address();if(!address || typeof address==='string')throw new Error('Agent tool server failed to bind');
 return {
  url:`http://127.0.0.1:${address.port}/mcp`,
  register:ws=>{const token=randomBytes(32).toString('base64url');sessions.set(token,ws);return token;},
  unregister:token=>{sessions.delete(token);},
  close:()=>new Promise(resolve=>server.close(()=>resolve())),
 };
}
