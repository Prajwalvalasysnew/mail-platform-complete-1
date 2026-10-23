// Local visual QA only. Never copied into the public Next.js directory.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pages=new Set(['Valasys Mail Landing v16.dc.html','Sign In.dc.html','Create Account.dc.html','Talk to Sales.dc.html','support.js']);
const port=Number(process.env.LANDING_REFERENCE_PORT || 3002);
http.createServer(async(req,res)=>{
 try{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1) || 'Valasys Mail Landing v16.dc.html';let file;
 if(pages.has(name))file=path.join(root,'design-reference',name);
 else if(/^assets\/shot-[a-z]+\.png$/.test(name))file=path.join(root,'public',name);
 else if(/^_fonts\/(instrument-sans|inter|inter-tight|jetbrains-mono)\/[a-z0-9-]+\.woff2?$/.test(name)){const [,family,font]=name.split('/');file=path.join(root,'../../node_modules',family==='instrument-sans'?'@fontsource-variable':'@fontsource',family,'files',font);}
 else{res.writeHead(404);res.end('Not found');return;}
 const bytes=await fs.readFile(file);res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type',name.endsWith('.png')?'image/png':name.endsWith('.woff2')?'font/woff2':name.endsWith('.woff')?'font/woff':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(bytes);
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Original landing reference: http://127.0.0.1:${port}`));
