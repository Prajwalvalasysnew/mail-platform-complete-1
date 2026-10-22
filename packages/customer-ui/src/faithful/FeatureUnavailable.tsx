import {Link} from 'react-router-dom';
export function FeatureUnavailable({name}:{name:string}){
  return <main className="auth-shell" style={{display:'grid',placeItems:'center',padding:24}}><section className="customer-dialog" role="status"><h2>{name}</h2><p>This feature is still being integrated with its backend. No sample workspace data, simulated approvals or browser-only saves are available here.</p><p><Link to="/">Back to your workspace</Link></p><p><Link to="/email-builder">Open the connected email editor</Link></p></section></main>;
}
