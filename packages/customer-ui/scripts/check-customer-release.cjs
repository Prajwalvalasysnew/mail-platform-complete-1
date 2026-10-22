// Read-only configuration preflight. No DNS queries, sends or deployment.
const {checkConfig}=require('../../shared/dist/config-guard.js');
const {isIP}=require('node:net');
function publicOrigin(value){
 try{
  const url=new URL(value),host=url.hostname;
  // A public customer release requires a DNS host with an owned-domain TLS
  // certificate. Literal IPs (including URL-normalized integer/hex forms),
  // single-label/internal hosts and reserved examples are not release targets.
  return url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&!url.search&&url.pathname==='/'
   && !isIP(host.replace(/^\[|\]$/g,'')) && host.includes('.') && !host.endsWith('.')
   && !/(^|\.)(localhost|test|invalid|example|local|internal|lan|home|arpa)$|(^|\.)example\.(com|org|net)$/i.test(host);
 }catch{return false;}
}
function checkCustomerRelease(env=process.env){
 const base=checkConfig({...env,NODE_ENV:'production'}),errors=[...base.errors];
 if(env.NODE_ENV!=='production')errors.push('NODE_ENV must be production for a public release.');
 if(!publicOrigin(env.APP_BASE_URL))errors.push('APP_BASE_URL must be a real public HTTPS DNS origin, not a literal IP, local/dummy/example address.');
 const origins=(env.CORS_ALLOWED_ORIGINS || '').split(',').map(value=>value.trim()).filter(Boolean);
 if(!origins.length || origins.some(value=>!publicOrigin(value)) || !origins.includes(env.APP_BASE_URL?.replace(/\/$/,'')))errors.push('CORS_ALLOWED_ORIGINS must explicitly include the public frontend origin and contain no wildcard/local/dummy origins.');
 if(!['ses','haraka'].includes(env.DELIVERY_TRANSPORT || ''))errors.push('DELIVERY_TRANSPORT must select a configured real transport; local Mailpit is not production delivery.');
 if(env.PLATFORM_MAIL_DELIVERY && env.PLATFORM_MAIL_DELIVERY!=='transport')errors.push('PLATFORM_MAIL_DELIVERY must use transport for account verification/reset/invitation emails.');
 if(env.DELIVERY_TRANSPORT==='ses' && ['SES_SMTP_HOST','SES_SMTP_USER','SES_SMTP_PASS'].some(key=>!env[key] || /replace|example|change.me/i.test(env[key])))errors.push('SES SMTP host and credentials must be configured through secret management.');
 return {ok:errors.length===0,errors,warnings:base.warnings,verification:'Configuration only: DNS ownership, TLS, sender authentication, provider credentials, backups/restores and real recipient delivery still require independent acceptance.'};
}
module.exports={checkCustomerRelease};
if(require.main===module){const report=checkCustomerRelease();console.log(JSON.stringify(report,null,2));process.exitCode=report.ok?0:1;}
