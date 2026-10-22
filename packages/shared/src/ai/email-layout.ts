/** Trusted email rendering: models choose constrained design tokens and text, never executable HTML. */
type Block={type:string;text:string;url:string};
export type EmailDesign={theme:'indigo'|'ocean'|'forest'|'charcoal'|'rose';layout:'showcase'|'editorial'|'minimal';eyebrow:string;footer:string;
 /** Brand colour (#rrggbb); overrides the theme's accent and derives matching tints. */
 accent?:string};
const palettes={indigo:['#ede9fe','#5b3fc4','#211547'],ocean:['#e0f2fe','#0369a1','#0c2940'],forest:['#dcfce7','#167348','#123527'],charcoal:['#e5e7eb','#27272a','#18181b'],rose:['#ffe4e6','#be3455','#4c1627']};
const esc=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const HEX=/^#[0-9a-f]{6}$/i;
const mix=(hex:string,to:number,amount:number)=>'#'+[1,3,5].map(i=>Math.round(parseInt(hex.slice(i,i+2),16)*(1-amount)+to*amount).toString(16).padStart(2,'0')).join('');
/** Theme colours, or a palette derived from the brand colour: [soft tint, accent, dark ink]. */
export function emailPalette(design:Pick<EmailDesign,'theme'|'accent'>):[string,string,string]{
 if(design.accent && HEX.test(design.accent))return [mix(design.accent,255,0.9),design.accent.toLowerCase(),mix(design.accent,0,0.68)];
 return palettes[design.theme] as [string,string,string];
}
export function renderEmailLayout(blocks:Block[],preheader:string,design:EmailDesign,section=false,unsubscribe=false){
 const [soft,accent,ink]=emailPalette(design),minimal=design.layout==='minimal';
 const line=(s:string)=>esc(s).replace(/\n/g,'<br>');
 let hero=false;
 const parts=blocks.map(block=>{
  const content=line(block.text);
  if(block.type==='heading'){
   const first=!hero;hero=true;
   return first && !section?`<tr><td style="padding:40px 36px 32px;background:${minimal || design.layout==='editorial'?'#ffffff':soft};border-top:4px solid ${accent};border-bottom:1px solid #e5e7eb">${design.eyebrow?`<p style="margin:0 0 16px;font:700 12px/1.5 Arial,sans-serif;letter-spacing:2px;color:${accent}">${esc(design.eyebrow)}</p>`:''}<h1 style="margin:0;font:700 34px/1.18 Arial,sans-serif;letter-spacing:-1px;color:${ink}">${content}</h1></td></tr>`:`<tr><td style="padding:24px 36px 8px"><h2 style="margin:0;font:700 22px/1.3 Arial,sans-serif;color:${ink}">${content}</h2></td></tr>`;
  }
  if(block.type==='button')return `<tr><td style="padding:18px 36px 30px"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="${accent}" style="border-radius:8px"><a href="${esc(block.url)}" style="display:inline-block;padding:15px 24px;color:#ffffff;text-decoration:none;font:700 15px/1.3 Arial,sans-serif;border:1px solid ${accent};border-radius:8px">${content}</a></td></tr></table></td></tr>`;
  if(block.type==='feature')return `<tr><td style="padding:8px 36px"><table width="100%" role="presentation" cellspacing="0" cellpadding="0"><tr><td style="padding:20px;background:${soft};border-left:3px solid ${accent};border-radius:4px;font:400 15px/1.65 Arial,sans-serif;color:${ink}">${content}</td></tr></table></td></tr>`;
  if(block.type==='quote')return `<tr><td style="padding:22px 36px"><blockquote style="margin:0;border-left:3px solid ${accent};padding-left:18px;font:italic 18px/1.6 Georgia,serif;color:${ink}">${content}</blockquote></td></tr>`;
  return `<tr><td style="padding:16px 36px 8px;font:400 16px/1.7 Arial,sans-serif;color:#374151"><p style="margin:0">${content}</p></td></tr>`;
 });
 if(section)return `<div class="email"><table width="100%" role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${parts.join('')}</table></div>`;
 return `<div class="email" style="width:100%;max-width:640px;margin:24px auto;background:#f3f4f6;font-family:Arial,sans-serif;padding:20px 0"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div><table width="100%" role="presentation" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-collapse:separate;border-spacing:0;border-radius:12px;overflow:hidden">${parts.join('')}<tr><td style="padding:28px 36px 32px">${design.footer?`<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font:400 12px/1.6 Arial,sans-serif;color:#6b7280">${line(design.footer)}</p>`:''}${unsubscribe?`<p style="margin:0;padding-top:${design.footer?'8px':'20px'};${design.footer?'':'border-top:1px solid #e5e7eb;'}font:400 12px/1.6 Arial,sans-serif;color:#6b7280"><a href="{{unsubscribe_url}}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a></p>`:''}</td></tr></table></div>`;
}
