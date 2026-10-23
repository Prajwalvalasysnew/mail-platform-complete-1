import {useState,type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter-tight/600.css';
import '@fontsource/inter-tight/700.css';
import './login-design.css';

type Props={mfa:boolean;busy:boolean;error:string;visible:boolean;onSubmit:(event:FormEvent<HTMLFormElement>)=>void;onTogglePassword:()=>void;onSwitchAccount:()=>void};
const landingUrl=import.meta.env.VITE_LANDING_URL || 'http://localhost:3001';

export function LoginDesign({mfa,busy,error,visible,onSubmit,onTogglePassword,onSwitchAccount}:Props){
 const [notice,setNotice]=useState('');
 return <main className="customer-login">
  <div className="cl-grid" aria-hidden="true"/>
  <div className="cl-layout">
   <a href={landingUrl} className="cl-brand" aria-label="Valasys Mail home">
    <span className="cl-logo"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m2 7 10 6 10-6"/></svg></span>
    <span className="cl-display">Valasys <span className="cl-brand-muted">Mail</span></span>
   </a>
   <section className="cl-card" aria-labelledby="cl-heading">
    <h1 id="cl-heading" className="cl-display">{mfa?'Verify your sign-in':'Sign in to your workspace'}</h1>
    <p className="cl-description">{mfa?'Enter the code from your authenticator app.':'Welcome back. Your dashboard is waiting.'}</p>
    {!mfa && <>
     <div className="cl-providers">
      <button type="button" className="cl-button cl-secondary" onClick={()=>setNotice('Google sign-in is not activated. Continue with your work email and password.')}>
       <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.97 10.97 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
       Continue with Google
      </button>
      <button type="button" className="cl-button cl-secondary" onClick={()=>setNotice('SSO / SAML sign-in is not activated. Continue with your work email and password.')}>
       <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
       Continue with SSO / SAML
      </button>
     </div>
     <div className="cl-divider"><span/><span>or with email</span><span/></div>
    </>}
    <form className={mfa?'cl-form cl-mfa':'cl-form'} onSubmit={onSubmit} aria-busy={busy}>
     {mfa?<div><label className="cl-label" htmlFor="cl-code">Authentication code</label><input className="cl-input" id="cl-code" name="code" autoComplete="one-time-code" inputMode="numeric" minLength={6} maxLength={20} autoFocus required/></div>:<>
      <div><label className="cl-label" htmlFor="cl-email">Work email</label><input className="cl-input" id="cl-email" name="email" type="email" autoComplete="username" placeholder="you@company.com" maxLength={320} required/></div>
      <div>
       <div className="cl-password-label"><label className="cl-label" htmlFor="cl-password">Password</label><Link className="cl-link" to="/forgot-password">Forgot password?</Link></div>
       <div className="cl-password"><input className="cl-input" id="cl-password" name="password" type={visible?'text':'password'} autoComplete="current-password" maxLength={200} placeholder={'\u2022'.repeat(10)} required/>
        <button className="cl-eye" type="button" aria-label="Toggle password visibility" aria-pressed={visible} onClick={onTogglePassword}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></button>
       </div>
      </div>
     </>}
     {error && <p role="alert" className="cl-error">{error}</p>}
     <button className="cl-button cl-primary" type="submit" disabled={busy}>{busy?'Signing in\u2026':mfa?'Verify':'Sign in'}</button>
     {mfa && <button type="button" className="cl-switch cl-link" disabled={busy} onClick={onSwitchAccount}>Use another account</button>}
    </form>
   </section>
   {!mfa && <p className="cl-register">New to Valasys Mail? <Link className="cl-link" to="/register">Create a free account</Link></p>}
   <footer className="cl-footer">
    <a href={landingUrl}>{'\u2190'} Back to valasys.com</a><span>{'\u00b7'}</span>
    <a href="#" onClick={event=>{event.preventDefault();setNotice('The privacy page is not available yet.');}}>Privacy</a><span>{'\u00b7'}</span>
    <a href="#" onClick={event=>{event.preventDefault();setNotice('The terms page is not available yet.');}}>Terms</a>
   </footer>
  </div>
  {notice && <div className="cl-notice" role="status">{notice}<button type="button" aria-label="Dismiss message" onClick={()=>setNotice('')}>Dismiss</button></div>}
 </main>;
}
