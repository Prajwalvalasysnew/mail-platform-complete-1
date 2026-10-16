import { lazy, Suspense, useEffect } from 'react';
import { Provider, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { store, getResource, identityReceived, signedOut, restorationFailed, retrySession, type RootState } from './store';
import { DesignPage, FrontendErrorBoundary } from './DesignPage';
import { Login, PasswordRecovery, VerifyEmail, AcceptInvitation } from './Login';
import { prepareCustomer } from './customer-adapter';
import { prepareEmail } from './email-adapter';
import {FeatureUnavailable} from './FeatureUnavailable';
import {prepareWorkflow} from './workflow-adapter';
import {WorkspaceHandoff} from './WorkspaceHandoff';

const Customer = lazy(()=>import('./generated/Customer').then(module=>({default:()=> <DesignPage module={module} prepare={prepareCustomer} />})));
const Onboarding = lazy(()=>import('./generated/Customer').then(module=>({default:()=> <DesignPage module={module} prepare={prepareCustomer} />})));
const Registration = lazy(()=>import('./generated/Customer').then(module=>({default:()=> <DesignPage module={module} prepare={controller=>prepareCustomer(controller, true)} />})));
const Email = lazy(async()=>{
  const [module,grapes] = await Promise.all([import('./generated/Email'),import('grapesjs')]);
  // The reference does not display Font Awesome glyphs. Do not let the newer
  // runtime inject an external icon-font stylesheet and change its layout.
  (window as unknown as { grapesjs: unknown }).grapesjs = {...grapes.default,init:(config:any)=>grapes.default.init({...config,cssIcons:''})};
  await import('./grapes-reference.css');
  return { default:()=> <DesignPage module={module} prepare={location.pathname.startsWith('/__design/')?undefined:prepareEmail} /> };
});
const Workflow = lazy(()=>import('./generated/Workflow').then(module=>({default:()=> <DesignPage module={module} />})));
const LiveWorkflow = lazy(()=>import('./generated/Workflow').then(module=>({default:()=> <DesignPage module={module} prepare={prepareWorkflow} />})));
const Agent = lazy(()=>import('./generated/Agent').then(module=>({default:()=> <DesignPage module={module} />})));
const ReferenceCustomer = lazy(()=>import('./generated/Customer').then(module=>({default:()=> <DesignPage module={module} />})));

function ApplicationRoutes() {
  const session = useSelector((state: RootState)=>state.session);
  const location=useLocation();
  useEffect(()=>{
    if (!session.token) { store.dispatch(signedOut()); return; }
    if (session.status !== 'restoring') return;
    let active=true;const token=session.token;
    void getResource('/auth/me',true).then(identity=>{
      if(active && store.getState().session.token===token)store.dispatch(identityReceived(identity));
    }).catch(()=>{
      if(active && store.getState().session.token===token)store.dispatch(restorationFailed('We could not reach your workspace. Your session has been kept. Please retry.'));
    });
    return ()=>{active=false;};
  },[session.token,session.status]);
  const authenticated = session.status === 'authenticated';
  const opening=<div className="startup" role="status">{session.status==='unavailable'?<section style={{padding:24,maxWidth:460,textAlign:'center'}}><p>{session.error}</p><button onClick={()=>store.dispatch(retrySession())}>Retry connection</button></section>:'Opening workspace…'}</div>;
  const gated = (page: React.ReactNode)=>['restoring','unavailable'].includes(session.status) ? opening : authenticated ? page : <Navigate to="/login" state={{from:location.pathname+location.search}} replace />;
  return <Suspense fallback={<div className="startup">Opening workspace…</div>}><Routes>
    <Route path="/login" element={authenticated ? <Navigate to={typeof location.state?.from==='string' && location.state.from.startsWith('/') && !location.state.from.startsWith('//') && !location.state.from.startsWith('/login')?location.state.from:'/'} replace /> : ['restoring','unavailable'].includes(session.status) && session.token ? opening : <Login />} />
    <Route path="/register" element={<Registration />} />
    <Route path="/auth/callback" element={<WorkspaceHandoff/>}/>
    <Route path="/onboarding" element={gated(<Onboarding/>)}/>
    <Route path="/forgot-password" element={<PasswordRecovery key="forgot" />} />
    <Route path="/reset-password" element={<PasswordRecovery key="reset" />} />
    <Route path="/verify-email" element={<VerifyEmail />} />
    <Route path="/accept-invite" element={<AcceptInvitation />} />
    <Route path="/email-builder" element={gated(<Email />)} />
    <Route path="/workflow-builder" element={gated(<LiveWorkflow />)} />
    <Route path="/ai-agent" element={gated(<FeatureUnavailable name="AI agent" />)} />
    {import.meta.env.DEV && <><Route path="/__design/customer" element={<ReferenceCustomer />} /><Route path="/__design/email" element={<Email />} /><Route path="/__design/workflow" element={<Workflow />} /><Route path="/__design/agent" element={<Agent />} /></>}
    <Route path="*" element={gated(<Customer />)} />
  </Routes></Suspense>;
}
export function ProductionApp() {
  return <Provider store={store}><BrowserRouter><FrontendErrorBoundary><ApplicationRoutes /></FrontendErrorBoundary></BrowserRouter></Provider>;
}
