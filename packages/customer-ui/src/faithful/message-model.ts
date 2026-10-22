// Reference pills use six visual groups. Keep that presentation separate from
// the actual service status: queued mail must never be labelled as bounced or
// SMTP-accepted mail as delivered.
const group:Record<string,string>={delivered:'Delivered',opened:'Opened',clicked:'Clicked',bounced:'Bounced',hard_bounced:'Bounced',hard_bounce:'Bounced',soft_bounced:'Deferred',soft_bounce:'Deferred',complained:'Complaint',complaint:'Complaint',queued:'Deferred',held:'Deferred',sending:'Deferred',accepted:'Deferred',deferred:'Deferred',failed:'Bounced',rejected:'Bounced',suppressed:'Bounced'};
export function messageModel(row:Record<string,any>){
  const raw=String(row.status || 'unknown');
  return {id:row.message_id,to:row.to_address,from:row.from_address,subject:row.subject || '(no subject)',template:row.template_id || '',
    type:row.message_class==='commercial'?'Marketing':row.message_class==='transactional'?'Transactional':'Relationship',
    status:group[raw] || 'Deferred',actualStatus:raw.replaceAll('_',' ').replace(/^./,character=>character.toUpperCase()),
    opens:row.opened_at?1:0,clicks:row.first_clicked_at?1:0,time:new Date(row.queued_at),ip:row.sending_ip || '—'};
}
