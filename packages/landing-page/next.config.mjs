import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const apiOrigin=process.env.API_ORIGIN || 'http://127.0.0.1:3000';
export default {
  output:'standalone',
  outputFileTracingRoot:root,
  turbopack:{root},
  poweredByHeader:false,
  devIndicators:false,
  async rewrites(){return [{source:'/api/:path*',destination:`${apiOrigin}/v1/:path*`}];},
  async headers(){return [{source:'/:path*',headers:[{key:'X-Content-Type-Options',value:'nosniff'},{key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},{key:'X-Frame-Options',value:'DENY'}]}];},
};
