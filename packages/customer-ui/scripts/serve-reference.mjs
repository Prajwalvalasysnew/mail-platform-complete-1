import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const directory=path.resolve(process.argv[2]);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.css':'text/css','.woff2':'font/woff2'};
http.createServer((request,response)=>{
  let pathname;
  try { pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname); } catch {response.writeHead(400).end();return;}
  const file=path.resolve(directory,'.'+(pathname==='/'?'/Customer App.dc.html':pathname));
  if (!file.startsWith(directory+path.sep)) {response.writeHead(403).end();return;}
  fs.stat(file,(error,stat)=>{
    if(error || !stat.isFile()){response.writeHead(404).end();return;}
    response.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream'});
    fs.createReadStream(file).pipe(response);
  });
}).listen(5174,'127.0.0.1',()=>console.log('Reference preview: http://127.0.0.1:5174'));
