import type {DesignState} from './runtime';
import {errorMessage} from './Login';

// Separate read failures from mutation errors: retry must never replay a write.
export function readFeedback(c:DesignState,key:string,error?:unknown){
  const errors={...c.state.productionReadErrors};
  const message=error?errorMessage(error):undefined;
  if(errors[key]===message)return;
  if(message)errors[key]=message;else delete errors[key];
  c.setState({productionReadErrors:errors});
}

export function visibleReadErrors(c:DesignState):string[]{
  const sections:Record<string,string[]>= {home:['analytics'],analytics:['analytics'],contacts:['contacts'],lists:['audiences'],segments:['audiences'],deliverability:['deliverability'],automations:['automations'],settings:['settings'],templates:['templates'],messages:['messages'],apikeys:['keys'],webhooks:['webhooks'],logs:['logs']};
  return [...new Set(['profile',...(sections[c.state.view] || [])].map(key=>c.state.productionReadErrors?.[key]).filter(Boolean))] as string[];
}
