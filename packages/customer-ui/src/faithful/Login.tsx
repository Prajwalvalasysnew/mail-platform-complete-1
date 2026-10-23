import {useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {useSelector} from 'react-redux';
import {Link,useLocation,useNavigate} from 'react-router-dom';
import {performAction,store,tokenReceived,retrySession,signedOut,type RootState} from './store';
import './auth.css';
import {LoginDesign} from './LoginDesign';

const errors:Record<string,string>={invalid_credentials:'The email or password is incorrect.',invalid_mfa_code:'That authentication code is not valid. Try another code.',email_exists:'An account already uses this email. Please sign in.',validation_failed:'Please check the information you entered.',invalid_or_expired_token:'This link has expired or has already been used. Request a new one.',authentication_required:'Please sign in again.',insufficient_role:'Your role does not allow this action.'};
export function errorMessage(error:any){
  if(error?.data?.outcome_unknown)return error.data.message;
  if(error?.status===429)return 'Too many requests. Please wait a moment before trying again.';
  if(error?.status===403)return error?.data?.message || 'Your role does not allow this action.';
  if(typeof error?.status==='number' && error.status>=500)return 'The service is temporarily unavailable. Please try again shortly.';
  if(error?.status==='FETCH_ERROR' || error?.status==='TIMEOUT_ERROR')return 'We could not reach the server. Check your connection and try again.';
  return error?.data?.message || errors[error?.data?.error] || error?.data?.error || error?.message || 'Unable to complete this request. Please try again.';
}
export function AuthFrame({title,description,children}:{title:string;description:string;children:ReactNode}){
  return <div className="auth-shell"><aside className="auth-brand"><Link to="/login" aria-label="Valasys sign in"><span>V</span>Valasys</Link></aside><main className="auth-panel"><section className="auth-content"><h1>{title}</h1><p className="auth-description">{description}</p>{children}</section></main></div>;
}
export function AcceptInvitation(){
  const location=useLocation(),navigate=useNavigate(),token=new URLSearchParams(location.search).get('token');
  const [create,setCreate]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');const pending=useRef(false);
  const signedIn=useSelector((state:RootState)=>!!state.session.token);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(pending.current || !token)return;pending.current=true;setBusy(true);setError('');
    const data=new FormData(event.currentTarget);
    try{
      const result=await performAction('/team/invites/accept',{token,...(create?{name:String(data.get('name')).trim(),password:String(data.get('password'))}:{})});
      store.dispatch(tokenReceived(result));history.replaceState({},'',location.pathname);navigate('/login',{replace:true,state:{from:'/contacts'}});
    }catch(error:any){const code=error?.data?.error;if(code==='password_required'){setCreate(true);setError('Create your account to join this workspace.');}else setError(['invalid_invite','expired_invite'].includes(code)?'This invitation has expired, was revoked, or has already been used. Ask the workspace administrator for a new invitation.':errorMessage(error));}
    finally{pending.current=false;setBusy(false);}
  }
  return <AuthFrame title="Join your workspace" description="Accept the invitation sent to your email. Invitations can be used only once.">{!token?<p role="alert" className="auth-error">This invitation is missing its token. Ask your workspace administrator for a new link.</p>:<form onSubmit={submit} aria-busy={busy}>{signedIn && <p role="status">Accepting switches this browser to the invited account and workspace.</p>}<button className="auth-link" type="button" disabled={busy} onClick={()=>{setCreate(value=>!value);setError('');}}>{create?'I already have an account':'I need to create an account'}</button>{create && <><label>Full name<input name="name" autoComplete="name" maxLength={100} required disabled={busy}/></label><label>New account password<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={200} required disabled={busy}/></label><p className="auth-description">Existing account passwords are not changed by accepting an invitation.</p></>}{error && <p role="alert" className="auth-error">{error}</p>}<div className="auth-actions"><Link to="/login">Back to sign in</Link><button className="auth-primary" disabled={busy}>{busy?'Joining…':'Accept invitation'}</button></div></form>}</AuthFrame>;
}
export function Login(){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[visible,setVisible]=useState(false);
  const pending=useRef(false);
  const mfa=useSelector((state:RootState)=>state.session.status==='mfa');
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(pending.current)return;pending.current=true;setBusy(true);setError('');
    const data=new FormData(event.currentTarget);
    try{
      if(mfa){await performAction('/auth/mfa',{code:String(data.get('code')).trim()});store.dispatch(retrySession());}
      else{const result=await performAction('/auth/login',{email:String(data.get('email')).trim(),password:String(data.get('password'))});store.dispatch(tokenReceived(result));}
    }catch(error){setError(errorMessage(error));}
    finally{pending.current=false;setBusy(false);}
  }
  return <LoginDesign mfa={mfa} busy={busy} error={error} visible={visible} onSubmit={submit} onTogglePassword={()=>setVisible(value=>!value)} onSwitchAccount={()=>store.dispatch(signedOut())}/>;
}
export function PasswordRecovery(){
  const location=useLocation(),reset=location.pathname==='/reset-password';
  const token=new URLSearchParams(location.search).get('token');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false);
  const pending=useRef(false);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(pending.current)return;setError('');const data=new FormData(event.currentTarget);
    if(reset && data.get('password')!==data.get('confirm'))return setError('The passwords do not match.');
    pending.current=true;setBusy(true);
    try{await performAction(reset?'/auth/password/reset':'/auth/password/forgot',reset?{token,password:String(data.get('password'))}:{email:String(data.get('email')).trim()});setDone(true);if(reset)store.dispatch(signedOut());}
    catch(error){setError(errorMessage(error));}finally{pending.current=false;setBusy(false);}
  }
  return <AuthFrame title={reset?'Reset your password':'Forgot password?'} description={reset?'Choose a new password with at least 8 characters.':'Enter your account email to request a password reset link.'}>
    {done?<p role="status" className="auth-success">{reset?'Your password has been updated. Sign in with your new password.':'If an account uses that email, a reset link has been sent. Check your inbox.'}</p>:reset && !token?<p role="alert" className="auth-error">This reset link is missing its token. <Link to="/forgot-password">Request a new link</Link>.</p>:<form onSubmit={submit} aria-busy={busy}>{reset?<><label>New password<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={200} required /></label><label>Confirm password<input name="confirm" type="password" autoComplete="new-password" minLength={8} maxLength={200} required /></label></>:<label>Work email<input name="email" type="email" autoComplete="email" placeholder="you@company.com" required /></label>}{error && <p role="alert" className="auth-error">{error}</p>}<div className="auth-actions"><Link to="/login">Back to sign in</Link><button className="auth-primary" disabled={busy}>{busy?'Please wait…':reset?'Reset password':'Send reset link'}</button></div></form>}
    {done && <Link className="auth-return" to="/login">Back to sign in</Link>}
  </AuthFrame>;
}

export function VerifyEmail(){
  const location=useLocation(),token=new URLSearchParams(location.search).get('token');
  const [state,setState]=useState({busy:!!token,error:token?'':'This link is missing its verification token.',done:false});
  const request=useRef<{token:string;promise:Promise<any>} | null>(null);
  useEffect(()=>{
    if(!token)return;
    let active=true;
    if(request.current?.token!==token)request.current={token,promise:performAction('/auth/verify-email',{token})};
    void request.current.promise.then(()=>{if(active){setState({busy:false,error:'',done:true});history.replaceState({},'',location.pathname);}}).catch(error=>{if(active)setState({busy:false,error:errorMessage(error),done:false});});
    return ()=>{active=false;};
  },[token]);
  return <AuthFrame title="Verify your email" description="Confirm ownership of your account email before sending.">{state.busy?<p role="status">Verifying your email…</p>:state.done?<p role="status" className="auth-success">Your email is verified.</p>:<p role="alert" className="auth-error">{state.error}</p>}<Link className="auth-return" to="/">{state.done?'Continue to your workspace':'Back to sign in'}</Link></AuthFrame>;
}
