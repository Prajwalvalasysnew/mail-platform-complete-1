import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../customer-ui/src/faithful/store',()=>({getResource:vi.fn(),performAction:vi.fn(),store:{getState:()=>({session:{identity:{current_role:'owner'}}})}}));
import {getResource,performAction} from '../customer-ui/src/faithful/store';
import {installCustomerCampaigns} from '../customer-ui/src/faithful/customer-campaigns';
const row={id:'fixture-campaign',name:'Fixture',status:'draft',revision:0,audience_id:null,template_id:null,from_email:'',from_name:'',reply_to:'',subject:'',updated_at:new Date().toISOString(),stats:{total:0,delivered:0,opened:0,clicked:0,pending:0}};
function controller(){
 const c:any={props:{},state:{view:'campaigns',camps:[],nc:{name:'Fixture',audience:'all'},cOpen:null},toast:vi.fn(),setState(patch:any){this.state={...this.state,...patch};},openCamp(id:string){this.state.cOpen=id;},campaignsVals(){return {cRows:this.state.camps.map((item:any)=>({...item,menu:[]})),cKpis:[{},{},{},{}],cTabs:[],ncTypes:[],cTypeOpts:[],cdModes:[],cdStep:{to:{},time:{}}};},renderVals(){return {...this.campaignsVals(),pageActions:[]};}};
 c.openCamp=(id:string)=>{c.state.cOpen=id;};return c;
}
beforeEach(()=>{
 vi.resetAllMocks();vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn(),confirm:()=>true});
 vi.mocked(getResource).mockImplementation(async(path:string)=>path.endsWith('/campaigns')?{campaigns:Object.freeze([])}:path.endsWith('/audiences')?{collections:[]}:path.endsWith('/templates')?{templates:[]}:path.endsWith('/domains')?{domains:[]}:{stats:{subscribed:0}});
});
afterEach(()=>vi.unstubAllGlobals());
describe('customer campaign adapter',()=>{
 it('saves both subject variants and persists the chosen test type',async()=>{
  const c=controller(),adapter=installCustomerCampaigns(c);await adapter.refresh();c.state.nc.type='A/B test';vi.mocked(performAction).mockResolvedValue({...row,campaign_type:'ab_subject'});c.renderVals().ncCreate();await vi.waitFor(()=>expect(c.state.cOpen).toBe(row.id));expect(performAction).toHaveBeenCalledWith('/account/data/campaigns',expect.objectContaining({campaign_type:'ab_subject'}));
  expect(c.state.camps[0].type).toBe('A/B test');c.renderVals().onCdSubjectB({target:{value:'Second variant'}});vi.mocked(performAction).mockResolvedValue({...row,campaign_type:'ab_subject',subject_b:'Second variant',revision:1});c.renderVals().cdActions[0].onClick();await vi.waitFor(()=>expect(c.toast).toHaveBeenCalledWith('Campaign draft saved'));expect(performAction).toHaveBeenLastCalledWith(`/account/data/campaigns/${row.id}`,expect.objectContaining({subject_b:'Second variant'}),'PUT');adapter.dispose();
 });
 it('creates a real draft without mutating frozen query responses',async()=>{
  const c=controller(),adapter=installCustomerCampaigns(c);await adapter.refresh();
  vi.mocked(performAction).mockResolvedValue(Object.freeze({...row}));c.renderVals().ncCreate();
  await vi.waitFor(()=>expect(c.state.cOpen).toBe(row.id));expect(c.state.camps).toHaveLength(1);expect(c.renderVals().cdStatus).toBe('draft');adapter.dispose();
 });
 it('ignores an older refresh that resolves after a successful create',async()=>{
  const c=controller(),adapter=installCustomerCampaigns(c);await adapter.refresh();
  let resolveRead!:(value:any)=>void;const pending=new Promise(resolve=>{resolveRead=resolve;});
  vi.mocked(getResource).mockImplementation(async(path:string)=>path.endsWith('/campaigns')?pending:path.endsWith('/audiences')?{collections:[]}:path.endsWith('/templates')?{templates:[]}:path.endsWith('/domains')?{domains:[]}:{stats:{subscribed:0}});
  const refreshing=adapter.refresh();vi.mocked(performAction).mockResolvedValue({...row});c.renderVals().ncCreate();await vi.waitFor(()=>expect(c.state.cOpen).toBe(row.id));
  resolveRead({campaigns:[]});await refreshing;expect(c.state.camps.map((item:any)=>item.id)).toEqual([row.id]);adapter.dispose();
 });
 it('retains edits made while a draft save is in flight',async()=>{
  const c=controller(),adapter=installCustomerCampaigns(c);await adapter.refresh();vi.mocked(performAction).mockResolvedValue({...row});c.renderVals().ncCreate();await vi.waitFor(()=>expect(c.state.cOpen).toBe(row.id));
  c.renderVals().onCdSubject({target:{value:'First'}});
  let resolveSave!:(value:any)=>void;vi.mocked(performAction).mockImplementation(()=>new Promise(resolve=>{resolveSave=resolve;}));c.renderVals().cdActions[0].onClick();
  c.renderVals().onCdSubject({target:{value:'Second'}});resolveSave({...row,revision:1,subject:'First'});
  await vi.waitFor(()=>expect(c.toast).toHaveBeenCalledWith('Campaign draft saved'));expect(c.state.camps[0].subject).toBe('Second');expect(c.renderVals().cdMeta).toContain('Unsaved');adapter.dispose();
 });
});
