import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const child=spawn(process.execPath,[path.join(root,'.next/standalone/packages/landing-page/server.js')],{stdio:'inherit',env:{...process.env,PORT:process.env.PORT || '3001',HOSTNAME:process.env.LANDING_HOST || '127.0.0.1'}});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>{process.exitCode=code || 0;});
