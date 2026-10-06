import type { BrowserBridge } from '../browser-bridge';
import { ExecutionError } from '../execution';
import { matchesPddIdentity, completePddIdentities, isPddLoginConfirmed } from './pdd-identity';
import type { Shop, ShopLoginEvent, ShopLoginStatus } from '../../src/types';

const ORIGIN = 'https://mms.pinduoduo.com';
type Bridge = Pick<BrowserBridge, 'eval' | 'fill' | 'wait'>;
type LoginStructure = { headerPresent:boolean; bannerPresent:boolean; logoutTextPresent:boolean; logoutDomPresent:boolean; logoutVisible:boolean; maskedTextPresent:boolean; nameCount:number };
type LoginState = { trusted:boolean; signedIn:boolean; names:string[]; loginPage:boolean; form:boolean; challenge:boolean; rejected:boolean; structure?:LoginStructure };
export class ShopLoginError extends ExecutionError {
  constructor(public loginStatus:Exclude<ShopLoginStatus,'running'|'succeeded'>, message:string, public readonly diagnostics?:LoginStructure) { super('login_required',message,'retry'); }
}
// Return classifications only. Passwords, cookies and page text never enter progress records.
export const LOGIN_STATE = `(() => {
  if(location.origin!=='${ORIGIN}')return {trusted:false};
  const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
  const header=document.querySelector('header'),banner=document.querySelector('[role=banner]');
  const names=(header?.innerText||banner?.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean);
  const logoutTextPresent=names.includes('退出当前账号');
  const logoutElements=[...new Set([header,banner].filter(Boolean))].flatMap(e=>[e,...e.querySelectorAll('*')]).filter(e=>e.children.length===0&&e.textContent.trim()==='退出当前账号');
  const logoutDomPresent=logoutElements.length>0,logoutVisible=logoutElements.some(visible);
  const text=document.body.innerText;
  const loginPage=/^\\/login(?:\\/|$)/.test(location.pathname),form=visible(document.querySelector('#usernameId'))&&visible(document.querySelector('#passwordId'));
  const rejected=/账号或密码错误|账户或密码错误|用户名或密码错误|密码不正确|密码错误|账号不存在|账户不存在|账号已被锁定|账号被锁定/.test(text);
  const challenge=/请拖动滑块|拖动滑块完成|滑动完成验证|点击完成验证|请完成安全验证|请完成验证|请输入短信验证码/.test(text)||[...document.querySelectorAll('iframe')].some(e=>visible(e)&&/captcha|verify|验证码|安全验证/i.test(e.title+' '+e.src));
  return {trusted:true,names,signedIn:(logoutDomPresent||logoutTextPresent)&&!loginPage&&!form&&!rejected&&!challenge,
    structure:{headerPresent:!!header,bannerPresent:!!banner,logoutTextPresent,logoutDomPresent,logoutVisible,maskedTextPresent:names.some(s=>s.includes('*')),nameCount:names.length},
    loginPage,form,rejected,challenge};
})()`;
const SAME_SHOP = (s:LoginState,shop:Shop) => isPddLoginConfirmed(s,shop)&&matchesPddIdentity(s.names,shop);
const asciiLower = (value:string) => value.replace(/[A-Z]/g, c=>c.toLowerCase());
const caseOnly = (names:string[],value:string) => names.some(name=>name!==value&&asciiLower(name)===asciiLower(value));
// Only a complete shop + subaccount pair establishes an unambiguous other identity.
// A masked/incomplete identity must never trigger repeated logout and login attempts.
const completeIdentities = (s:LoginState) => completePddIdentities(s.names);
const canSwitchAccount = (s:LoginState,shop:Shop) => {
  const identities=completeIdentities(s);
  if(identities.length!==1)return false;
  if(asciiLower(identities[0].shop)===asciiLower(shop.name)&&shop.account.includes(':'))return asciiLower(identities[0].account)!==asciiLower(shop.account);
  if(caseOnly(s.names,shop.name)||caseOnly(s.names,shop.account))return false;
  return identities[0].shop!==shop.name||(shop.account.includes(':')&&identities[0].account!==shop.account);
};
const identityProblem = (s:LoginState,shop:Shop) => {
  if(caseOnly(s.names,shop.name))return `后台店铺名称与保存的“${shop.name}”仅大小写不同，请到店铺管理按后台名称修改后继续`;
  if(!s.names.includes(shop.name))return completeIdentities(s).length
    ? `后台店铺名称与保存的“${shop.name}”不一致，请核对店铺管理中的名称和当前后台店铺`
    : '后台已登录，但店铺与账号信息未完整读取，无法核对所选店铺；请检查后台账号区';
  if(caseOnly(s.names,shop.account))return '后台店铺名称已匹配，但登录账号与保存信息仅大小写不同，请到店铺管理按后台账号修改后继续';
  if(s.names.some(name=>name.includes('*'))&&!completeIdentities(s).some(identity=>identity.shop===shop.name))return '后台店铺名称已匹配，但登录账号被隐藏，无法确认所选子账号；已保留当前登录，请核对店铺登录信息';
  if(completeIdentities(s).some(identity=>identity.shop===shop.name))return '后台店铺名称已匹配，但登录账号与保存信息不一致，请核对店铺登录信息';
  return '后台店铺名称已匹配，但未读取到完整登录账号，无法确认所选子账号；已保留当前登录，请核对后台账号区';
};
export const shopIdentityMessage = (shop:Pick<Shop,'name'|'account'>) => shop.account.includes(':')
  ? `已核对后台店铺及登录账号：${shop.name}`
  : `已核对后台店铺：${shop.name}；普通账号按店铺名称核对`;

export class PddLogin {
  private lastState?:LoginState;
  constructor(private bridge:Bridge,private decrypt:(shop:Shop)=>Promise<string>,private onEvent:(event:ShopLoginEvent)=>void=()=>{},private guard:()=>void=()=>{}) {}
  private async step<T>(name:string,work:()=>Promise<T>):Promise<T>{
    this.guard();const startedAt=new Date().toISOString(),start=performance.now();
    this.onEvent({name,startedAt,status:'running'});
    try{const value=await work();this.onEvent({name,startedAt,status:'done',durationMs:Math.round(performance.now()-start)});return value;}
    catch(error){this.onEvent({name,startedAt,status:'failed',durationMs:Math.round(performance.now()-start)});throw error;}
  }
  private async state(){this.guard();return this.lastState=await this.bridge.eval<LoginState>(LOGIN_STATE,5000);}
  private async trusted(){if(!(await this.state()).trusted)throw new ShopLoginError('failed','登录页面地址不正确，已停止填写');}
  private async poll(check:(s:LoginState)=>boolean,message:string,timeout=15000){
    try{return await this.bridge.wait(async()=>{const s=await this.state();return check(s)?s:false;},timeout,message);}
    catch(error){if(error instanceof ExecutionError&&error.code==='page_timeout'){
      const state=this.lastState;
      const reason=state?.trusted&&!state.loginPage&&!state.form
        ? !state.names.length?'已离开登录页，但账号区未读取，尚不能确认后台登录身份；已保留当前页面，请核对后台账号区'
          :'已离开登录页，账号区已读取，但未识别到登录完成标记；已保留当前页面，请核对后台登录状态'
        : message;
      throw new ShopLoginError('failed',reason,state?.structure);
    }throw error;}
  }
  private async verify(shop:Shop){
    const result=await this.poll(s=>s.trusted&&(isPddLoginConfirmed(s,shop)||s.rejected||s.challenge),'登录尚未确认，请查看已连接的浏览器后核对登录结果',20000);
    if(isPddLoginConfirmed(result,shop)){
      if(!SAME_SHOP(result,shop))throw new ShopLoginError('failed',identityProblem(result,shop),result.structure);
      return;
    }
    if(result.rejected)throw new ShopLoginError('credentials_rejected','后台提示账号或密码有误或账号被锁定，请修改店铺登录信息；程序不会反复尝试');
    throw new ShopLoginError('verification_required','请在已连接的浏览器完成验证码或短信验证，再点击“核对登录结果”');
  }
  async run(shop:Shop,mode:'reuse'|'relogin'|'check'='reuse'){
    this.lastState=undefined;
    if(mode==='check'){await this.step(shop.account.includes(':')?'核对店铺与登录账号':'核对后台店铺',()=>this.verify(shop));return;}
    const initial=await this.step('读取当前登录状态',()=>this.poll(s=>s.trusted&&(isPddLoginConfirmed(s,shop)||s.loginPage||s.form||s.challenge||s.rejected),'后台登录页面未加载，请检查已连接的浏览器'));
    const confirmed=isPddLoginConfirmed(initial,shop);
    if(mode==='reuse'&&SAME_SHOP(initial,shop)){await this.step(shop.account.includes(':')?'核对店铺与登录账号':'核对后台店铺',()=>this.verify(shop));return;}
    if(mode==='reuse'&&confirmed&&!canSwitchAccount(initial,shop))throw new ShopLoginError('failed',`${identityProblem(initial,shop)}。身份未确认，未退出或重新登录`,initial.structure);
    // A resumed task must preserve a pending challenge instead of resubmitting credentials.
    if(mode==='reuse'&&initial.challenge)throw new ShopLoginError('verification_required','请先在已连接的浏览器完成登录验证，再继续任务');
    let password='';
    await this.step('读取本机保存的登录信息',async()=>{
      try{password=await this.decrypt(shop);}catch{throw new ShopLoginError('failed','无法读取已保存的密码，请检查系统凭据授权或重新保存店铺密码');}
      if(!password)throw new ShopLoginError('credentials_rejected','未保存登录密码，请到店铺管理补充');
    });
    try{
      if(confirmed)await this.step('退出当前账号',async()=>{
        await this.trusted();
        const clicked=await this.bridge.eval<boolean>(`(() => {
          if(location.origin!=='${ORIGIN}')return false;
          const es=[...document.querySelectorAll('header *,[role=banner] *')].filter(e=>e.children.length===0&&e.getClientRects().length&&e.textContent.trim()==='退出当前账号');
          if(es.length!==1)return false;es[0].click();return true;
        })()`,5000);
        if(!clicked)throw new ShopLoginError('failed','未能唯一找到退出账号入口，请在已连接的浏览器核对');
        let confirmed=false;
        try{await this.bridge.wait(async()=>{
          const s=await this.state();if(!s.trusted)throw new ShopLoginError('failed','退出后页面地址不正确');
          if(!s.signedIn&&s.loginPage)return true;
          if(!confirmed)confirmed=await this.bridge.eval<boolean>(`(() => {
            if(location.origin!=='${ORIGIN}')return false;
            const dialogs=[...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(e=>e.getClientRects().length&&/退出.*(?:账号|登录)|(?:确认|确定).*退出/.test(e.innerText));
            if(dialogs.length!==1)return false;
            const buttons=[...dialogs[0].querySelectorAll('button,[role=button]')].filter(e=>e.getClientRects().length&&!e.disabled&&/^(确定|确认|确认退出|退出登录)$/.test(e.textContent.trim()));
            if(buttons.length!==1)return false;buttons[0].click();return true;
          })()`,5000);
          return false;
        },15000,'退出登录未确认，请检查已连接的浏览器');}
        catch(error){if(error instanceof ExecutionError&&error.code==='page_timeout')throw new ShopLoginError('failed','退出登录未确认，请检查已连接的浏览器');throw error;}
      });
      await this.step('切换账号密码登录',async()=>{
        await this.trusted();
        await this.poll(s=>s.loginPage||s.form,'退出后未进入登录页');
        try{await this.bridge.wait(async()=>{
          const s=await this.state();if(!s.trusted)throw new ShopLoginError('failed','登录页面地址不正确，已停止填写');if(s.form)return true;
          return this.bridge.eval<boolean>(`(() => {
            if(location.origin!=='${ORIGIN}')return false;
            const es=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.getClientRects().length&&e.textContent.trim()==='账号登录');
            if(es.length!==1)return false;es[0].click();return true;
          })()`,5000);
        },10000,'账号登录入口未显示');}
        catch(error){if(error instanceof ExecutionError&&error.code==='page_timeout')throw new ShopLoginError('failed','账号登录入口未显示，请检查已连接的浏览器');throw error;}
        await this.poll(s=>s.trusted&&s.form,'账号密码输入框未显示，请检查登录方式');
      });
      await this.step('填写保存的账号和密码',async()=>{
        await this.trusted();
        try{await this.bridge.fill('#usernameId',shop.account);await this.trusted();await this.bridge.fill('#passwordId',password);}
        catch(error){if(error instanceof ExecutionError)throw error;throw new ShopLoginError('failed','账号密码填写未确认，请检查登录页面');}
      });
      password='';
      await this.step('点击登录',async()=>{
        await this.trusted();
        const clicked=await this.bridge.eval<boolean>(`(() => {
          if(location.origin!=='${ORIGIN}')return false;
          const es=[...document.querySelectorAll('button,a,[role=button]')].filter(e=>e.getClientRects().length&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&/^登\\s*录$/.test(e.textContent.trim()));
          if(es.length!==1)return false;es[0].click();return true;
        })()`,5000);
        if(!clicked)throw new ShopLoginError('failed','登录按钮未就绪或无法唯一定位，请检查已连接的浏览器');
      });
      await this.step(shop.account.includes(':')?'核对店铺与登录账号':'核对后台店铺',()=>this.verify(shop));
    }finally{password='';}
  }
}
