import assert from 'node:assert/strict';
import {messageModel} from '../src/faithful/message-model.ts';
const row={message_id:'test',from_address:'sender@example.test',to_address:'recipient@example.test',queued_at:new Date().toISOString(),subject:'Status checks',message_class:'commercial'};
for(const [status,category,label] of [['queued','Deferred','Queued'],['held','Deferred','Held'],['sending','Deferred','Sending'],['accepted','Deferred','Accepted'],['soft_bounced','Deferred','Soft bounced'],['hard_bounced','Bounced','Hard bounced'],['failed','Bounced','Failed'],['suppressed','Bounced','Suppressed'],['delivered','Delivered','Delivered']]){
  const result=messageModel({...row,status});
  assert.equal(result.status,category);assert.equal(result.actualStatus,label);assert.equal(result.type,'Marketing');
}
const engagement=messageModel({...row,status:'delivered',opened_at:new Date().toISOString(),first_clicked_at:null,message_class:'relationship'});
assert.equal(engagement.opens,1);assert.equal(engagement.clicks,0);assert.equal(engagement.type,'Relationship');
assert.equal(messageModel({...row,status:'unknown_new_state'}).actualStatus,'Unknown new state');
console.log('PASS all delivery status groups, actual labels, message classification and observed engagement');
