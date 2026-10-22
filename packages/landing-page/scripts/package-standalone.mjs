import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=path.join(root,'.next/standalone/packages/landing-page');
await fs.access(path.join(output,'server.js'));
await fs.cp(path.join(root,'public'),path.join(output,'public'),{recursive:true});
await fs.cp(path.join(root,'.next/static'),path.join(output,'.next/static'),{recursive:true});
console.log('Standalone server packaged with local fonts and screenshots.');
