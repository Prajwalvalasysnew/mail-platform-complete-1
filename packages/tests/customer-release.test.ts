import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
const {checkCustomerRelease}=createRequire(import.meta.url)('../customer-ui/scripts/check-customer-release.cjs');
describe('customer release preflight',()=>{
 it('rejects local/dummy release settings without exposing secret values',()=>{
  const secret='do-not-print-this-secret';const result=checkCustomerRelease({NODE_ENV:'development',APP_BASE_URL:'http://localhost:8080',CORS_ALLOWED_ORIGINS:'*',DELIVERY_TRANSPORT:'mailpit',PLATFORM_MAIL_DELIVERY:'capture',JWT_SECRET:secret});
  expect(result.ok).toBe(false);expect(result.errors.join(' ')).toContain('APP_BASE_URL');expect(result.errors.join(' ')).toContain('CORS_ALLOWED_ORIGINS');expect(result.errors.join(' ')).toContain('DELIVERY_TRANSPORT');expect(JSON.stringify(result)).not.toContain(secret);
 });
 it('does not treat HTTPS example/test origins as real public configuration',()=>{
  for(const origin of ['https://app.example.com','https://app.example.invalid','https://app.example.test','https://app.example'])expect(checkCustomerRelease({APP_BASE_URL:origin}).errors.some((error:string)=>error.startsWith('APP_BASE_URL'))).toBe(true);
 });
 it('rejects literal/private/internal targets even when HTTPS is selected',()=>{
  for(const host of ['10.0.0.1','172.20.0.1','192.168.0.1','169.254.169.254','2130706433','0x7f000001','[::1]','[::ffff:7f00:1]','[fd00::1]','api','app.internal','app.local','app.lan','app.example.com.'])expect(checkCustomerRelease({APP_BASE_URL:`https://${host}`}).errors.some((error:string)=>error.startsWith('APP_BASE_URL'))).toBe(true);
 });
});
