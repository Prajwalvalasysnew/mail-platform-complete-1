import React from 'react';
type Controller=React.Component<any,any> & Record<string,any>;
const customerOrigin=process.env.NEXT_PUBLIC_CUSTOMER_UI_URL || 'http://localhost:8080';
export function customerUrl(path:string){return new URL(path,customerOrigin).href;}
export function Feedback({controller}:{controller:Controller}){
 return controller.state.feedback?<div className="landing-feedback" role="status">{controller.state.feedback}<button aria-label="Dismiss message" onClick={()=>controller.setState({feedback:''})}>Dismiss</button></div>:null;
}
export function prepareController(c:Controller,page:string){
 let pending=false,authorization='',requestId='';
 const post=async(path:string,body:unknown,token?:string)=>{
  let response:Response;
  try{response=await fetch(`/api${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});}catch{throw new Error('The request outcome could not be confirmed. Check your connection and account before submitting again; the server may have saved the change.');}
  const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.message || ({invalid_credentials:'The email or password is incorrect.',email_exists:'An account already uses this email. Please sign in.',validation_failed:'Please check your form fields.'} as Record<string,string>)[result.error] || (response.status===429?'Too many attempts. Please wait before trying again.':'The service could not complete this request. Please try again.'));return result;
 };
 const authenticate=async(event:React.FormEvent<HTMLFormElement>)=>{
  event.preventDefault();if(pending)return;const form=event.currentTarget,value=(id:string)=>(form.querySelector<HTMLInputElement>(`#${id}`)?.value || '').trim();pending=true;c.setState({busy:true,feedback:''});
  try{
   if(!authorization){const register=page==='CreateAccount',prefix=register?'ca':'si',password=form.querySelector<HTMLInputElement>(`#${prefix}-pass`)!.value;const result=await post(register?'/auth/register':'/auth/login',{email:value(`${prefix}-email`),password,...(register?{name:[value('ca-first'),value('ca-last')].filter(Boolean).join(' ')}:{})});authorization=result.token;if(register)c.setState({created:true});}
   const result=await post('/auth/handoff',{destination:page==='CreateAccount'?'onboarding':'workspace'},authorization);
   const destination=new URL('/auth/callback',customerOrigin);destination.hash=new URLSearchParams({code:result.code}).toString();authorization='';window.location.assign(destination.href);
  }catch(error){c.setState({feedback:error instanceof Error?error.message:'The request outcome is uncertain. Check your account before submitting again.'});}
  finally{pending=false;c.setState({busy:false});}
 };
 const submitSales=async(event:React.FormEvent<HTMLFormElement>)=>{
  event.preventDefault();if(pending)return;const form=event.currentTarget,value=(id:string)=>(form.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(`#${id}`)?.value || '').trim();requestId ||= crypto.randomUUID();pending=true;c.setState({busy:true,feedback:''});
  try{await post('/landing/sales-requests',{request_id:requestId,first_name:value('ts-first'),last_name:value('ts-last'),email:value('ts-email'),company:value('ts-company'),monthly_volume:value('ts-volume'),message:value('ts-msg'),consent_confirmed:true});c.setState({sent:true});}catch(error){c.setState({feedback:error instanceof Error?error.message:'The request outcome is uncertain. Keep the form and try again with the same request ID.'});}finally{pending=false;c.setState({busy:false});}
 };
 const mounted=c.componentDidMount?.bind(c),unmounted=c.componentWillUnmount?.bind(c);
 const placeholder=(event:MouseEvent)=>{const target=event.target instanceof Element?event.target.closest<HTMLAnchorElement>('a[href="#"]'):null;if(!target)return;event.preventDefault();if(target.textContent?.trim()==='Forgot password?'){window.location.assign(customerUrl('/forgot-password'));return;}if(target.closest('header') && target.textContent?.includes('Mail')){window.scrollTo({top:0,behavior:'smooth'});return;}c.setState({feedback:'This destination is not included in the supplied design yet. No external page or service was opened.'});};
 c.componentDidMount=()=>{mounted?.();document.documentElement.dataset.landingHydrated='true';document.addEventListener('click',placeholder);};
 c.componentWillUnmount=()=>{authorization='';unmounted?.();document.removeEventListener('click',placeholder);};
 const original=c.renderVals.bind(c);
 c.renderVals=()=>{
  const values=original();
  if(page==='Landing'){
   // The original is an animation, not a sender or DNS lookup. Preserve its
   // presentation without claiming a real message was delivered or a domain
   // passed checks. No anonymous email endpoint is opened by the landing site.
   values.sendTest=()=>c.setState({feedback:'This is a product demonstration. To send a real test email, sign in to your workspace and verify your sending domain.'});
   values.runCheck=()=>c.setState({feedback:'Domain verification runs securely in your customer workspace. Add your domain there to check its actual DNS records.'});
  }else if(page==='SignIn' || page==='CreateAccount'){
   values.onSubmit=authenticate;
   values.noop=(event:React.SyntheticEvent)=>{event.preventDefault();c.setState({feedback:'Social and SSO sign-in are not activated on this landing site. Continue through the existing customer workspace.'});};
   values.signedIn=false;values.submitLabel=c.state.busy?'Please wait…':c.state.created?'Continue to workspace':page==='SignIn'?'Sign in':'Create account';
  }else if(page==='Sales'){
   values.onSubmit=submitSales;
  }
  return values;
 };
}
