import React from 'react';
export function asList(value:unknown):any[]{return Array.isArray(value)?value:[];}
const styles=new Map<string,React.CSSProperties>();
export function cssStyle(value:string|React.CSSProperties|undefined){
 if(!value || typeof value!=='string')return value;
 const cached=styles.get(value);if(cached)return cached;
 const result:Record<string,string>={};
 for(const declaration of value.split(';')){const colon=declaration.indexOf(':');if(colon<0)continue;const property=declaration.slice(0,colon).trim();if(!property)continue;result[property.startsWith('--')?property:property.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=declaration.slice(colon+1).trim();}
 if(styles.size>3000)styles.clear();styles.set(value,result);return result;
}
export function interpolate(value:unknown,key:number):React.ReactNode{
 if(value==null || typeof value==='boolean')return null;
 return <React.Fragment key={key}>{React.isValidElement(value)||Array.isArray(value)?value as React.ReactNode:<span className="sc-interp">{String(value)}</span>}</React.Fragment>;
}
