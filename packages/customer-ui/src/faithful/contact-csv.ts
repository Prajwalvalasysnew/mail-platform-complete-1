export function parseContactCsv(text:string){
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
  const input=text.replace(/^\uFEFF/,'');
  for(let i=0;i<input.length;i++){
    const character=input[i];
    if(character==='"'){if(quoted && input[i+1]==='"'){cell+='"';i++;}else if(!quoted && (cell.length || closed))throw new Error('Invalid CSV quote.');else{closed=quoted;quoted=!quoted;}}
    else if(character===',' && !quoted){row.push(cell);cell='';closed=false;}
    else if((character==='\r' || character==='\n') && !quoted){if(character==='\r' && input[i+1]==='\n')i++;row.push(cell);if(row.some(value=>value.trim()))rows.push(row);row=[];cell='';closed=false;}
    else if(closed && !quoted){if(!/[\t ]/.test(character))throw new Error('Invalid text after a closing CSV quote.');}
    else cell+=character;
    if(rows.length>201)throw new Error('Import at most 200 contacts per CSV.');
  }
  if(quoted)throw new Error('The CSV contains an unclosed quote.');
  row.push(cell);if(row.some(value=>value.trim()))rows.push(row);
  if(rows.length<2 || rows.length>201)throw new Error('The CSV must contain a header and between 1 and 200 contacts.');
  const headers=rows.shift()!.map(value=>value.trim().toLowerCase().replaceAll(' ','_'));
  if(new Set(headers).size!==headers.length)throw new Error('CSV column names must be unique.');
  const emailIndex=headers.findIndex(header=>['email','email_address'].includes(header));
  if(emailIndex<0)throw new Error('An email or email_address column is required.');
  return rows.map((values,index)=>{
    if(values.length!==headers.length)throw new Error(`CSV row ${index+2} has the wrong number of columns.`);
    const get=(key:string)=>values[headers.indexOf(key)]?.trim() || '';
    const email=values[emailIndex].trim().toLowerCase();
    const rawStatus=get('status') || 'Pending';const status=['Pending','Subscribed','Unsubscribed'].find(value=>value.toLowerCase()===rawStatus.toLowerCase());
    if(!status)throw new Error(`CSV row ${index+2} has an unsupported status.`);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error(`CSV row ${index+2} has an invalid email address.`);
    return {email,name:get('name') || [get('first_name'),get('last_name')].filter(Boolean).join(' ') || email,company:get('company'),location:get('location'),status};
  });
}
