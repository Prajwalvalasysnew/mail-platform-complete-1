import React, { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import type { DesignState, DesignValues } from './runtime';

export type DesignModule = {
  DesignController: new (props: DesignValues) => DesignState;
  ReferenceView: React.ComponentType<{ controller: DesignState }>;
  referenceCss: string;
};
export function DesignPage({ module, options = {}, prepare }: {
  module: DesignModule; options?: DesignValues; prepare?: (controller: DesignState) => void | (()=>void);
}) {
  const [, update] = useReducer(n=>n+1,0);
  const ref = useRef<DesignState | null>(null);
  const disposeRef = useRef<(()=>void) | undefined>();
  if (!ref.current) {
    ref.current = new module.DesignController(options);
    const dispose = prepare?.(ref.current);
    disposeRef.current = dispose || undefined;
  }
  const controller = ref.current;
  useLayoutEffect(() => {
    const style = document.createElement('style');
    style.dataset.referenceStyle = 'true'; style.textContent = module.referenceCss;
    document.head.append(style);
    controller.notify = update;
    controller.componentDidMount();
    return () => { controller.notify = undefined; controller.componentWillUnmount(); disposeRef.current?.(); style.remove(); };
  },[controller,module]);
  const previousProps = useRef(controller.props);
  const previousState = useRef(controller.state);
  useEffect(()=>{ controller.componentDidUpdate(previousProps.current,previousState.current); previousProps.current = controller.props; previousState.current = controller.state; });
  const View = module.ReferenceView;
  const Overlay=controller.props.overlay as React.ComponentType<{controller:DesignState}> | undefined;
  return <div className="reference-host"><View controller={controller} />{Overlay && <Overlay controller={controller}/>}</div>;
}

export class FrontendErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error('Customer UI render failed', error,info); }
  render() {
    if (this.state.error) return <main role="alert" style={{padding:32,fontFamily:'Geist,system-ui'}}><h1>Unable to open this screen</h1><p>Please reload to try again.</p><button onClick={()=>location.reload()}>Reload</button></main>;
    return this.props.children;
  }
}
