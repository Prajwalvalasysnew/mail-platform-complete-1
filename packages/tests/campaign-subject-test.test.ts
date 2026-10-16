import {describe,it,expect} from 'vitest';
import {subjectTestPayload,frozenRecipients,frozenLaunchId,batchCampaignResult} from '../api/src/lib/campaign-subject-test';
describe('frozen subject-line test',()=>{
 it.each([2,3,100])('assigns all %i recipients once with a balanced split and frozen nonce',count=>{
  const base={to:Array.from({length:count},(_,i)=>`person-${i}@example.test`),subject:'A',metadata:{campaign_id:'campaign',campaign_launch_id:'private-nonce'},send_at:'2030-01-01T12:00:00.000Z'};
  const original=JSON.stringify(base),payload=subjectTestPayload(base,'B');
  expect(JSON.stringify(base)).toBe(original);expect(new Set(frozenRecipients(payload)).size).toBe(count);expect(frozenRecipients(payload)?.sort()).toEqual([...base.to].sort());
  expect(payload.messages.filter(message=>message.metadata.campaign_variant==='A')).toHaveLength(Math.ceil(count/2));expect(payload.messages.filter(message=>message.metadata.campaign_variant==='B')).toHaveLength(Math.floor(count/2));
  for(const message of payload.messages){expect(message.subject).toBe(message.metadata.campaign_variant);expect(message.send_at).toBe(base.send_at);}
  expect(frozenLaunchId(payload)).toBe('private-nonce');
 });
 it('keeps legacy campaign recovery and refuses malformed/mixed-nonce snapshots',()=>{
  expect(frozenRecipients({to:['a@example.test']})).toEqual(['a@example.test']);expect(frozenRecipients({messages:[]})).toBeNull();expect(frozenRecipients({messages:[{to:'a@example.test',metadata:{campaign_launch_id:'a'}},{to:'b@example.test',metadata:{campaign_launch_id:'b'}}]})).toBeNull();
 });
 it('only cancellation-authorizes accepted message IDs and exposes partial results',()=>{
  expect(batchCampaignResult({accepted:1,rejected:1,suppressed:1,results:[{accepted:true,message_id:'accepted'},{accepted:false,message_id:'rejected'},{suppressed:true}]})).toMatchObject({message_ids:['accepted'],partial:true});
 });
});
