import {useEffect,useRef,useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {AuthFrame,errorMessage} from './Login';
import {performAction,store,tokenReceived} from './store';
export function WorkspaceHandoff(){
 const navigate=useNavigate(),[code]=useState(()=>new URLSearchParams(location.hash.slice(1)).get('code') || '');
 const [state,setState]=useState({email:'',busy:true,error:''}),pending=useRef(false),inspection=useRef<Promise<any>|null>(null);
 useEffect(()=>{history.replaceState({},'',location.pathname);if(!code){setState({email:'',busy:false,error:'This sign-in link is missing its code. Return to sign in.'});return;}let active=true;inspection.current ??= performAction('/auth/handoff/inspect',{code});void inspection.current.then(result=>{if(active)setState({email:result.email,busy:false,error:''});}).catch(error=>{if(active)setState({email:'',busy:false,error:errorMessage(error)});});return()=>{active=false;};},[code]);
 async function accept(){if(pending.current || !state.email)return;pending.current=true;setState(previous=>({...previous,busy:true,error:''}));try{const result=await performAction('/auth/handoff/redeem',{code,confirmed:true});store.dispatch(tokenReceived(result));const destination=result.destination==='onboarding'?'/onboarding':'/';navigate(result.mfa_required?'/login':destination,{replace:true,state:{from:destination}});}catch(error){setState(previous=>({...previous,busy:false,error:errorMessage(error)}));}finally{pending.current=false;}}
 return <AuthFrame title="Continue to your workspace" description="Confirm the account before continuing. This replaces any workspace session in this tab.">{state.busy && <p role="status">Opening secure sign-in…</p>}{state.error && <p role="alert" className="auth-error">{state.error}</p>}{state.email && <button className="auth-primary" disabled={state.busy} onClick={()=>void accept()}>Continue as {state.email}</button>}<Link className="auth-return" to="/login">Use a different account</Link></AuthFrame>;
}
