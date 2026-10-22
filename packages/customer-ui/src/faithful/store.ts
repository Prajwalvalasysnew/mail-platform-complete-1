import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { setupListeners } from '@reduxjs/toolkit/query';
import type { Identity } from '../api';

type Session = { token: string | null; identity: Identity | null; status: 'restoring' | 'anonymous' | 'mfa' | 'authenticated' | 'unavailable'; error?:string };
const session = createSlice({
  name: 'session',
  initialState: { token: sessionStorage.getItem('valasys.session'), identity: null, status: sessionStorage.getItem('valasys.mfa_pending')==='true'?'mfa':'restoring' } as Session,
  reducers: {
    tokenReceived(state, action: PayloadAction<{ token: string; mfa_required?: boolean }>) {
      state.identity=null;state.error=undefined;
      state.token = action.payload.token;
      state.status = action.payload.mfa_required ? 'mfa' : 'restoring';
    },
    identityReceived(state, action: PayloadAction<Identity>) { state.identity = action.payload; state.status = 'authenticated';state.error=undefined; },
    restorationFailed(state,action:PayloadAction<string>){state.status='unavailable';state.error=action.payload;},
    retrySession(state){if(state.token){state.status='restoring';state.error=undefined;}},
    signedOut(state) { state.token = null; state.identity = null; state.status = 'anonymous';state.error=undefined; },
  },
});
const workspace = createSlice({
  name: 'workspace', initialState: { view: 'home', collapsed: false },
  reducers: {
    navigated(state, action: PayloadAction<string>) { state.view = action.payload; },
    sidebarChanged(state, action: PayloadAction<boolean>) { state.collapsed = action.payload; },
  },
});

const authenticatedQuery=fetchBaseQuery({baseUrl:'/api',timeout:20000,prepareHeaders(headers,{getState}){
  const token=(getState() as {session:Session}).session.token;
  if(token)headers.set('Authorization',`Bearer ${token}`);
  return headers;
}});
export const customerApi = createApi({
  reducerPath: 'customerApi',
  baseQuery: async(args,api,extra)=>{
    const token=(api.getState() as {session:Session}).session.token;
    const method=typeof args==='string'?'GET':(args.method || 'GET').toUpperCase();
    if(!navigator.onLine)return {error:{status:'FETCH_ERROR' as const,error:'You are offline. Reconnect and try again.'}};
    let result=await authenticatedQuery(args,api,extra);
    // A transient GET may be repeated once. Never retry writes, timeouts,
    // validation, permission or rate-limit failures: outcomes may be ambiguous.
    if(method==='GET' && ['FETCH_ERROR',502,503,504].includes(result.error?.status as any) && !api.signal.aborted){
      await new Promise<void>(resolve=>{
        const done=()=>{clearTimeout(timer);api.signal.removeEventListener('abort',done);resolve();};
        const timer=setTimeout(done,400);api.signal.addEventListener('abort',done,{once:true});
      });
      if(!api.signal.aborted && (api.getState() as {session:Session}).session.token===token)result=await authenticatedQuery(args,api,extra);
    }
    const path=typeof args==='string'?args:args.url;
    if(result.error?.status===401 && token && !['/auth/login','/auth/register','/auth/mfa'].includes(path) && (api.getState() as {session:Session}).session.token===token){
      api.dispatch(session.actions.signedOut());
      api.dispatch({type:'customerApi/resetApiState'});
    }
    return result;
  },
  tagTypes: ['Workspace'],
  endpoints: (builder) => ({
    resource: builder.query<any, string>({ query: path => path, providesTags: ['Workspace'] }),
    // Autosaves invalidate Workspace queries. A live AI poll must survive those writes.
    aiResource: builder.query<any, string>({ query: path => path, keepUnusedDataFor: 5 }),
    action: builder.mutation<any, { path: string; method?: string; body?: unknown }>({
      query: ({ path, method = 'POST', body }) => ({ url: path, method, body }), invalidatesTags: ['Workspace'],
    }),
  }),
});
export const { tokenReceived, identityReceived, signedOut, restorationFailed, retrySession } = session.actions;
export const { navigated, sidebarChanged } = workspace.actions;
export const store = configureStore({
  reducer: { session: session.reducer, workspace: workspace.reducer, [customerApi.reducerPath]: customerApi.reducer },
  middleware: getDefault => getDefault().concat(customerApi.middleware),
  devTools: import.meta.env.DEV,
});
setupListeners(store.dispatch);
let previousToken=store.getState().session.token;
store.subscribe(() => {
  const token = store.getState().session.token;
  if(token!==previousToken){
    previousToken=token;
    for(const query of store.dispatch(customerApi.util.getRunningQueriesThunk()))query.abort();
    store.dispatch(customerApi.util.resetApiState());
  }
  if (token) sessionStorage.setItem('valasys.session',token);
  else sessionStorage.removeItem('valasys.session');
  sessionStorage.setItem('valasys.mfa_pending',String(store.getState().session.status==='mfa'));
});
export type RootState = ReturnType<typeof store.getState>;

export async function getResource(path: string, force = false) {
  const endpoint=path.startsWith('/account/ai/')?customerApi.endpoints.aiResource:customerApi.endpoints.resource;
  const request = store.dispatch(endpoint.initiate(path, { subscribe: path.startsWith('/account/ai/'), forceRefetch: force }));
  try { return await request.unwrap(); } finally { request.unsubscribe(); }
}
export async function performAction(path: string, body?: unknown, method = 'POST') {
  const request = store.dispatch(customerApi.endpoints.action.initiate({ path, body, method }));
  try { return await request.unwrap(); }
  catch(error:any){
    if(navigator.onLine && ['FETCH_ERROR','TIMEOUT_ERROR','PARSING_ERROR'].includes(error?.status))throw {...error,data:{...error.data,outcome_unknown:true,message:'The request outcome could not be confirmed. Check the latest records before submitting again; the server may have saved the change.'}};
    throw error;
  }finally { request.reset(); }
}
