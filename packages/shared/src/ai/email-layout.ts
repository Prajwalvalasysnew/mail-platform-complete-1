/** Trusted email rendering: models choose constrained design tokens and text, never executable HTML. */
export type EmailBlock={type:string;text:string;url:string;title?:string;label?:string};
export type EmailDesign={theme:'indigo'|'ocean'|'forest'|'charcoal'|'rose';layout:'showcase'|'editorial'|'minimal'|'newsletter';eyebrow:string;footer:string;
 /** Brand colour (#rrggbb); overrides the theme's accent and derives matching tints. */
 accent?:string;brandName?:string;tagline?:string;ink?:string;background?:string;footerBackground?:string;websiteUrl?:string};
const palettes={indigo:['#ede9fe','#5b3fc4','#211547'],ocean:['#e0f2fe','#0369a1','#0c2940'],forest:['#dcfce7','#167348','#123527'],charcoal:['#e5e7eb','#27272a','#18181b'],rose:['#ffe4e6','#be3455','#4c1627']};
const esc=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const HEX=/^#[0-9a-f]{6}$/i;
const mix=(hex:string,to:number,amount:number)=>'#'+[1,3,5].map(i=>Math.round(parseInt(hex.slice(i,i+2),16)*(1-amount)+to*amount).toString(16).padStart(2,'0')).join('');
/** Theme colours, or a palette derived from the brand colour: [soft tint, accent, dark ink]. */
export function emailPalette(design:Pick<EmailDesign,'theme'|'accent'>):[string,string,string]{
 if(design.accent && HEX.test(design.accent))return [mix(design.accent,255,0.9),design.accent.toLowerCase(),mix(design.accent,0,0.68)];
 return palettes[design.theme] as [string,string,string];
}
/** Preserve explicit brand labels even when the model puts them into body blocks. */
export function newsletterDesignFromBrief(design:EmailDesign,brief:string):EmailDesign{
 if(design.layout!=='newsletter')return design;
 const tagline=brief.match(/\btagline\s*(?:is|:|=)?\s*["“]([^"”\n]{1,160})["”]/i)?.[1];
 const eyebrow=brief.match(/\beyebrow\s*(?:label|text)?\s*(?:is|:|=)?\s*["“]([^"”\n]{1,80})["”]/i)?.[1] || brief.match(/\beyebrow\s+([A-Z][A-Z0-9 /&-]{1,79})(?=,|\.|$)/)?.[1];
 return {...design,...(tagline?{tagline:tagline.trim()}:{}),...(eyebrow?{eyebrow:eyebrow.trim()}:{})};
}
/** A complete newsletter composition, rather than independently styled paragraph rows. */
function renderNewsletter(blocks:EmailBlock[],preheader:string,design:EmailDesign,unsubscribe:boolean){
 const [soft,accent,paletteInk]=emailPalette(design),ink=design.ink && HEX.test(design.ink)?design.ink:paletteInk;
 const background=design.background && HEX.test(design.background)?design.background:'#f2f6fb';
 const footerBackground=design.footerBackground && HEX.test(design.footerBackground)?design.footerBackground:ink;
 const line=(text:string)=>esc(text).replace(/\n/g,'<br>');
 const button=(label:string,url:string,color=accent)=>`<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="${color}" style="border-radius:6px;background-color:${color}"><a href="${esc(url)}" style="display:inline-block;padding:14px 22px;color:#ffffff;font:700 15px/20px Arial,Helvetica,sans-serif;text-decoration:none">${line(label)}</a></td></tr></table>`;
 const heading=(text:string,hero=false)=>`<${hero?'h1':'h2'} style="margin:0 0 ${hero?'18':'10'}px;color:${ink};font:${hero?'700 32px/39px':'700 25px/31px'} Arial,Helvetica,sans-serif">${line(text)}</${hero?'h1':'h2'}>`;
 const paragraph=(text:string)=>`<p style="margin:0 0 20px;color:#425875;font:400 16px/26px Arial,Helvetica,sans-serif">${line(text)}</p>`;
 const same=(a:string,b:string)=>a.trim().toLowerCase().replace(/\s+/g,' ')===b.trim().toLowerCase().replace(/\s+/g,' ');
 blocks=blocks.filter(block=>!(design.tagline && same(block.text,design.tagline)));
 const rows:string[]=[];let hero=false;
 for(let i=0;i<blocks.length;i++){
  const block=blocks[i]!;
  if(!hero && block.type==='heading'){
   let title=block.text;
   if(design.eyebrow && title.toLowerCase().startsWith(design.eyebrow.toLowerCase()) && /^[\s:\-–—]/.test(title.slice(design.eyebrow.length))){const rest=title.slice(design.eyebrow.length).replace(/^[\s:\-–—]+/,'');if(rest)title=rest;}
   hero=true;let content=(design.eyebrow?`<p style="margin:0 0 12px;color:${accent};font:700 13px/18px Arial,Helvetica,sans-serif;letter-spacing:2px">${line(design.eyebrow)}</p>`:'')+heading(title,true);
   // Keep the hero's supporting copy and primary action in the same coloured band.
   while(blocks[i+1]?.type==='paragraph')content+=paragraph(blocks[++i]!.text);
   if(blocks[i+1]?.type==='button'){const cta=blocks[++i]!;content+=button(cta.text,cta.url);}
   rows.push(`<tr><td style="padding:42px 30px 38px;background-color:${soft}">${content}</td></tr>`);continue;
  }
  if(block.type==='feature'){
   const cards=[block];while(blocks[i+1]?.type==='feature')cards.push(blocks[++i]!);
   const cardRows=[];
   for(let n=0;n<cards.length;n+=2){
    cardRows.push(`<tr>${cards.slice(n,n+2).map(card=>`<td width="50%" valign="top" style="width:50%;padding:18px 14px;border:1px solid #e4edf7">${card.title?`<h3 style="margin:0 0 8px;color:${accent};font:700 17px/23px Arial,Helvetica,sans-serif">${line(card.title)}</h3>`:''}<p style="margin:0;color:#52657f;font:400 14px/22px Arial,Helvetica,sans-serif">${line(card.text)}</p></td>`).join('')}${n+1>=cards.length?'<td width="50%" style="width:50%"></td>':''}</tr>`);
   }
   rows.push(`<tr><td style="padding:20px 20px 30px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse">${cardRows.join('')}</table></td></tr>`);continue;
  }
  if(block.type==='cta'){
   rows.push(`<tr><td style="padding:28px 30px;background-color:${soft}">${block.title?heading(block.title):''}${paragraph(block.text)}${block.url?button(block.label || 'Learn more',block.url,ink):''}</td></tr>`);continue;
  }
  if(block.type==='heading'){
   let next=i+1,copy='';while(blocks[next]?.type==='paragraph')copy+=paragraph(blocks[next++]!.text);
   // Models may express the closing action using the older block vocabulary.
   // Compose that triplet as one action band rather than three unrelated rows.
   if(blocks[next]?.type==='button'){const action=blocks[next]!;rows.push(`<tr><td style="padding:28px 30px;background-color:${soft}">${heading(block.text)}${copy}${button(action.text,action.url,ink)}</td></tr>`);i=next;continue;}
  }
  if(block.type==='heading')rows.push(`<tr><td style="padding:34px 24px 4px;text-align:center">${heading(block.text)}</td></tr>`);
  else if(block.type==='button')rows.push(`<tr><td style="padding:18px 30px 30px">${button(block.text,block.url)}</td></tr>`);
  else if(block.type==='quote')rows.push(`<tr><td style="padding:22px 30px"><blockquote style="margin:0;border-left:3px solid ${accent};padding-left:18px;color:${ink};font:italic 18px/28px Georgia,serif">${line(block.text)}</blockquote></td></tr>`);
  else rows.push(`<tr><td style="padding:8px 30px 12px;${blocks[i-1]?.type==='heading'?'text-align:center':''}">${paragraph(block.text)}</td></tr>`);
 }
 const brand=design.brandName?`<p style="margin:0 0 5px;color:${ink};font:700 25px/30px Arial,Helvetica,sans-serif">${line(design.brandName)}</p>`:'';
 const tagline=design.tagline?`<p style="margin:0;color:#667994;font:400 12px/18px Arial,Helvetica,sans-serif">${line(design.tagline)}</p>`:'';
 const header=brand || tagline?`<tr><td style="padding:26px 30px;background-color:#ffffff">${brand}${tagline}</td></tr>`:'';
 const footerLinks=[...(design.websiteUrl?[`<a href="${esc(design.websiteUrl)}" style="color:#ffffff;text-decoration:underline">Visit our website</a>`]:[]),...(unsubscribe?['<a href="{{unsubscribe_url}}" style="color:#ffffff;text-decoration:underline">Unsubscribe</a>']:[])];
 const footer=design.brandName || design.footer || footerLinks.length?`<tr><td style="padding:24px 30px;background-color:${footerBackground};text-align:center">${design.brandName?`<p style="margin:0 0 8px;color:#ffffff;font:700 19px/25px Arial,Helvetica,sans-serif">${line(design.brandName)}</p>`:''}${design.tagline?`<p style="margin:0 0 14px;color:#d5e3f5;font:400 12px/19px Arial,Helvetica,sans-serif">${line(design.tagline)}</p>`:''}${footerLinks.length?`<p style="margin:0 0 10px;color:#ffffff;font:400 12px/19px Arial,Helvetica,sans-serif">${footerLinks.join(' &nbsp; | &nbsp; ')}</p>`:''}${design.footer?`<p style="margin:0;color:#d5e3f5;font:400 11px/17px Arial,Helvetica,sans-serif">${line(design.footer)}</p>`:''}</td></tr>`:'';
 return `<div class="email" style="width:100%;background-color:${background};font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${line(preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:${background}"><tr><td align="center" style="padding:24px 0"><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" align="center" style="width:100%;max-width:600px;background-color:#ffffff;border-collapse:collapse">${header}${rows.join('')}${footer}</table></td></tr></table></div>`;
}
export function renderEmailLayout(blocks:EmailBlock[],preheader:string,design:EmailDesign,section=false,unsubscribe=false){
 if(design.layout==='newsletter' && !section)return renderNewsletter(blocks,preheader,design,unsubscribe);
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
  if(block.type==='feature')return `<tr><td style="padding:8px 36px"><table width="100%" role="presentation" cellspacing="0" cellpadding="0"><tr><td style="padding:20px;background:${soft};border-left:3px solid ${accent};border-radius:4px;font:400 15px/1.65 Arial,sans-serif;color:${ink}">${block.title?`<h3 style="margin:0 0 8px;font-size:17px">${line(block.title)}</h3>`:''}${content}</td></tr></table></td></tr>`;
  if(block.type==='cta')return `<tr><td style="padding:28px 36px;background:${soft}">${block.title?`<h2 style="margin:0 0 10px;color:${ink};font:700 23px/29px Arial,sans-serif">${line(block.title)}</h2>`:''}<p style="margin:0 0 20px;color:${ink};font:400 16px/26px Arial,sans-serif">${content}</p>${block.url?`<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="${accent}" style="border-radius:6px"><a href="${esc(block.url)}" style="display:inline-block;padding:14px 22px;color:#fff;text-decoration:none;font:700 15px/20px Arial,sans-serif">${line(block.label || 'Learn more')}</a></td></tr></table>`:''}</td></tr>`;
  if(block.type==='quote')return `<tr><td style="padding:22px 36px"><blockquote style="margin:0;border-left:3px solid ${accent};padding-left:18px;font:italic 18px/1.6 Georgia,serif;color:${ink}">${content}</blockquote></td></tr>`;
  return `<tr><td style="padding:16px 36px 8px;font:400 16px/1.7 Arial,sans-serif;color:#374151"><p style="margin:0">${content}</p></td></tr>`;
 });
 if(section)return `<div class="email"><table width="100%" role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${parts.join('')}</table></div>`;
 return `<div class="email" style="width:100%;max-width:640px;margin:24px auto;background:#f3f4f6;font-family:Arial,sans-serif;padding:20px 0"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div><table width="100%" role="presentation" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-collapse:separate;border-spacing:0;border-radius:12px;overflow:hidden">${parts.join('')}<tr><td style="padding:28px 36px 32px">${design.footer?`<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font:400 12px/1.6 Arial,sans-serif;color:#6b7280">${line(design.footer)}</p>`:''}${unsubscribe?`<p style="margin:0;padding-top:${design.footer?'8px':'20px'};${design.footer?'':'border-top:1px solid #e5e7eb;'}font:400 12px/1.6 Arial,sans-serif;color:#6b7280"><a href="{{unsubscribe_url}}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a></p>`:''}</td></tr></table></div>`;
}
