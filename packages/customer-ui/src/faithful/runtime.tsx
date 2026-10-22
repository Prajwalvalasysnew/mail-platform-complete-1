import React from 'react';

export type DesignValues = Record<string, any>;

// Controller state is transient UI state. Network data and authentication live
// in Redux/RTK Query. This adapter preserves the reference event contracts while
// the migrated views are split into feature components.
export class DesignState {
  props: DesignValues;
  state: DesignValues = {};
  notify: (() => void) | undefined;
  constructor(props: DesignValues = {}) { this.props = props; }
  setState(update: DesignValues | ((state: DesignValues) => DesignValues), callback?: () => void) {
    const patch = typeof update === 'function' ? update(this.state) : update;
    this.state = { ...this.state, ...patch };
    this.notify?.();
    if (callback) queueMicrotask(callback);
  }
  forceUpdate() { this.notify?.(); }
  componentDidMount() {}
  componentDidUpdate(_previousProps: DesignValues, _previousState: DesignValues) {}
  componentWillUnmount() {}
  renderVals(): DesignValues { return {}; }
}

const styleCache = new Map<string, React.CSSProperties>();
export function cssStyle(css: string | React.CSSProperties | undefined): React.CSSProperties | undefined {
  if (!css) return undefined;
  if (typeof css !== 'string') return css;
  const cached = styleCache.get(css);
  if (cached) return cached;
  const result: Record<string,string> = {};
  for (const declaration of css.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0,colon).trim();
    if (!property) continue;
    const key = property.startsWith('--') ? property : property.replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase());
    result[key] = declaration.slice(colon+1).trim();
  }
  if (styleCache.size > 5000) styleCache.clear();
  styleCache.set(css,result);
  return result;
}
export function asList(value: unknown): any[] { return Array.isArray(value) ? value : []; }
export function referenceText(text:string,overrides?:Record<string,string>):string {
  const key=text.trim();
  return overrides && Object.prototype.hasOwnProperty.call(overrides,key) ? text.replace(key,overrides[key]) : text;
}
export function interpolate(value: unknown,key: number): React.ReactNode {
  if (value == null || typeof value === 'boolean') return null;
  if (React.isValidElement(value) || Array.isArray(value)) return <React.Fragment key={key}>{value as React.ReactNode}</React.Fragment>;
  return <span key={key} className="sc-interp">{String(value)}</span>;
}
