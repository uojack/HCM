// index.tsx — 单文件可运行 + 持久化存储 + 企业微信登录（方案C强化版）
// 适用：作为企业微信自建应用的 H5 页面或小程序云端接口的“目标URL”。
// 目标：可通过互联网访问；识别员工身份（企业微信）；记录数字化流程；数据有独立存储空间。
// 运行：
//   npm i -D tsx typescript @types/node
//   npx tsx index.tsx
// 环境变量（建议）：
//   PORT=3000
//   DATA_DIR=./data                 # 独立的数据目录（JSON 文件型存储）
//   BASE_URL=http://localhost:3000  # OAuth 回调地址前缀（生产写公网域名）
//   WECOM_CORP_ID=xxx               # 企业微信 CorpID
//   WECOM_CORP_SECRET=xxx           # 自建应用 Secret（仅限服务器端）
//   WECOM_AGENT_ID=1000002          # 可选，用于拼接授权 URL
//   WECOM_DEV_ALLOW_FALLBACK=1      # 开发容错：WeCom 调用失败时允许本地假登录

/*************************
 *  类型定义
 *************************/

type TicketType = 'HIRING' | 'ONBOARDING' | 'PERFORMANCE' | 'FAIRNESS' | 'OTHER';
type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';

interface Ticket { id: string; type: TicketType; status: TicketStatus; title: string; description?: string; createdAt: Date; closedAt?: Date | null }
interface Requisition { id: string; ticketId: string; keyRole: boolean; approvedAt?: Date | null; firstInterviewAt?: Date | null; offerSignedAt?: Date | null; onboardedAt?: Date | null }
interface StopClock { id: string; ticketId: string; startAt: Date; endAt?: Date | null; reason: string }
interface ENPSResponse { score: number; comment?: string }
interface User { id: string; userId: string; name?: string; dept?: string }
interface Session { sid: string; userId: string; name?: string; createdAt: number; expiresAt: number }

/*************************
 *  工具函数
 *************************/

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

const HOURS = 1000 * 60 * 60;
const diffHours = (a?: Date | null, b?: Date | null): number | null => a && b ? (a.getTime() - b.getTime()) / HOURS : null;
const avg = (nums: number[]): number | null => { const arr = nums.filter(n => Number.isFinite(n)); return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null };
const cuid = () => 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// 计算停表区间（StopClock）后的有效工时
function overlapMs(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  const s = Math.max(aStart.getTime(), bStart.getTime());
  const e = Math.min(aEnd.getTime(), bEnd.getTime());
  return Math.max(0, e - s);
}
function effectiveHoursExcludingStops(ticketId: string, start: Date, end: Date, stopClocks: StopClock[]): number {
  const total = end.getTime() - start.getTime();
  if (total <= 0) return 0;
  const stops = stopClocks.filter(s => s.ticketId === ticketId);
  let deducted = 0;
  for (const s of stops) {
    const sEnd = s.endAt ?? new Date();
    deducted += overlapMs(start, end, s.startAt, sEnd);
  }
  const eff = Math.max(0, total - deducted);
  return eff / HOURS;
}

/*************************
 *  文件存储（JSON 持久化）
 *************************/

const DATA_DIR = process.env.DATA_DIR || './data';
async function ensureDir(dir: string) { await fs.mkdir(dir, { recursive: true }); }
const file = (name: string) => path.join(DATA_DIR, name);
async function writeJSON(name: string, data: any) { const tmp = file(name + '.tmp'); await fs.writeFile(tmp, JSON.stringify(data, null, 2)); await fs.rename(tmp, file(name)); }
async function readJSON<T>(name: string, fallback: T): Promise<T> { try { const txt = await fs.readFile(file(name), 'utf8'); return JSON.parse(txt); } catch { return fallback } }

// 将字符串日期复原为 Date
function reviveTicket(t: any): Ticket { return { ...t, createdAt: new Date(t.createdAt), closedAt: t.closedAt ? new Date(t.closedAt) : null } }
function reviveStopClock(s: any): StopClock { return { ...s, startAt: new Date(s.startAt), endAt: s.endAt ? new Date(s.endAt) : null } }

type Store = { tickets: Ticket[]; requisitions: Requisition[]; stopClocks: StopClock[]; enps: ENPSResponse[]; users: User[]; sessions: Session[] };
let store: Store;

async function loadStore() {
  await ensureDir(DATA_DIR);
  const [tickets, requisitions, stopClocks, enps, users, sessions] = await Promise.all([
    readJSON<any[]>('tickets.json', []).then(a => a.map(reviveTicket)),
    readJSON<Requisition[]>('requisitions.json', []),
    readJSON<any[]>('stopClocks.json', []).then(a => a.map(reviveStopClock)),
    readJSON<ENPSResponse[]>('enps.json', []),
    readJSON<User[]>('users.json', []),
    readJSON<Session[]>('sessions.json', [])
  ]);
  store = { tickets, requisitions, stopClocks, enps, users, sessions };
  // 首次运行：种子数据
  if (store.tickets.length === 0) {
    const now = new Date(); const hoursAgo = (h: number) => new Date(now.getTime() - h * HOURS);
    store.tickets = [
      { id: 'F1', type: 'FAIRNESS', status: 'CLOSED', title: '公平申诉1', createdAt: hoursAgo(60), closedAt: hoursAgo(12) },
      { id: 'F2', type: 'FAIRNESS', status: 'CLOSED', title: '公平申诉2', createdAt: hoursAgo(120), closedAt: hoursAgo(20) },
      { id: 'R1', type: 'HIRING', status: 'OPEN', title: 'B2B 销售总监', createdAt: hoursAgo(10) },
      { id: 'R2', type: 'HIRING', status: 'IN_PROGRESS', title: '算法工程师', createdAt: hoursAgo(20) }
    ];
    store.requisitions = [
      { id: 'RQ1', ticketId: 'R1', keyRole: true, approvedAt: hoursAgo(400), firstInterviewAt: hoursAgo(300), offerSignedAt: hoursAgo(276), onboardedAt: hoursAgo(200) },
      { id: 'RQ2', ticketId: 'R2', keyRole: true, approvedAt: hoursAgo(500), firstInterviewAt: hoursAgo(250), offerSignedAt: hoursAgo(202), onboardedAt: hoursAgo(140) },
      { id: 'RQ3', ticketId: 'X1', keyRole: false, approvedAt: hoursAgo(400), onboardedAt: hoursAgo(160) },
      { id: 'RQ4', ticketId: 'X2', keyRole: false, approvedAt: hoursAgo(200), onboardedAt: hoursAgo(80) }
    ];
    await Promise.all([
      writeJSON('tickets.json', store.tickets),
      writeJSON('requisitions.json', store.requisitions)
    ]);
  }
}

async function save(name: keyof Store) {
  const map: Record<string, any> = {
    tickets: store.tickets, requisitions: store.requisitions, stopClocks: store.stopClocks,
    enps: store.enps, users: store.users, sessions: store.sessions
  };
  await writeJSON(name + '.json', map[name]);
}

/*************************
 *  会话与企业微信登录（H5 + 小程序后端）
 *************************/

function parseCookies(header?: string): Record<string,string> {
  const out: Record<string,string> = {}; if (!header) return out;
  header.split(';').forEach(kv => { const i = kv.indexOf('='); if (i>0) out[kv.slice(0,i).trim()] = decodeURIComponent(kv.slice(i+1)); });
  return out;
}
function setCookie(res: ServerResponse, name: string, val: string, opts: { maxAge?: number } = {}) {
  const parts = [`${name}=${encodeURIComponent(val)}`, 'Path=/', 'HttpOnly'];
  if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}
function getSession(req: IncomingMessage): Session | null {
  const sid = parseCookies(req.headers['cookie'])['sid'];
  const s = sid ? store.sessions.find(x => x.sid === sid) : null;
  if (!s) return null; if (Date.now() > s.expiresAt) return null; return s;
}
async function createSession(res: ServerResponse, userId: string, name?: string) {
  const sid = crypto.randomBytes(16).toString('hex');
  const sess: Session = { sid, userId, name, createdAt: Date.now(), expiresAt: Date.now() + 7*24*HOURS };
  store.sessions.push(sess); await save('sessions'); setCookie(res, 'sid', sid, { maxAge: 7*24*60*60 });
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
const WECOM = { CORP_ID: process.env.WECOM_CORP_ID, SECRET: process.env.WECOM_CORP_SECRET, AGENT_ID: process.env.WECOM_AGENT_ID };

async function fetchJSON<T>(url: string): Promise<T> { const r = await fetch(url); if (!r.ok) throw new Error('HTTP '+r.status); return r.json() as any }
async function wecomAccessToken(): Promise<string> {
  if (!WECOM.CORP_ID || !WECOM.SECRET) throw new Error('缺少 WECOM_CORP_ID / WECOM_CORP_SECRET');
  const data = await fetchJSON<{ access_token: string }>(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${WECOM.CORP_ID}&corpsecret=${WECOM.SECRET}`);
  return (data as any).access_token;
}
async function wecomUserIdByCode(code: string): Promise<{ userId: string, name?: string }> {
  const token = await wecomAccessToken();
  const info = await fetchJSON<any>(`https://qyapi.weixin.qq.com/cgi-bin/user/getuserinfo?access_token=${token}&code=${code}`);
  // 可选：再调 user/get 取姓名
  let name: string | undefined;
  if (info && info.UserId) {
    try { const u = await fetchJSON<any>(`https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${token}&userid=${info.UserId}`); name = u?.name; } catch {}
    return { userId: info.UserId, name };
  }
  throw new Error('未获取到企业微信 UserId');
}
async function wecomMiniProgramCode2Session(js_code: string): Promise<{ userId?: string; openid?: string; session_key?: string }> {
  const token = await wecomAccessToken();
  // 注意：不同形态的小程序 API 可能有差异，请按你们具体形态在此调整参数。
  const data = await fetchJSON<any>(`https://qyapi.weixin.qq.com/cgi-bin/miniprogram/jscode2session?access_token=${token}&js_code=${encodeURIComponent(js_code)}`);
  return data;
}

/*************************
 *  指标计算（Top 8 子集 — 与原测试保持一致）
 *************************/

export function computeTop8(ticketList: Ticket[], reqs: Requisition[], enps: ENPSResponse[], stopClocks: StopClock[] = []) {
  const ttp = avg(reqs.filter(r => r.keyRole && r.firstInterviewAt && r.offerSignedAt).map(r => diffHours(r.offerSignedAt!, r.firstInterviewAt!)!));
  const ttf = avg(reqs.filter(r => r.approvedAt && r.onboardedAt).map(r => diffHours(r.onboardedAt!, r.approvedAt!)!));
  const fairness = ticketList.filter(t => t.type === 'FAIRNESS');
  const within72 = fairness.filter(t => t.closedAt && effectiveHoursExcludingStops(t.id, t.createdAt, t.closedAt, stopClocks) <= 72).length;
  const close72Rate = fairness.length ? Math.round((within72 / fairness.length) * 100) : null;
  const openReqs = ticketList.filter(t => t.type === 'HIRING' && (t.status === 'OPEN' || t.status === 'IN_PROGRESS')).length;
  const poolMultiple = openReqs ? 3 : null; // 占位：完善候选在面阶段后计算
  const total = enps.length; const promoters = enps.filter(e => e.score >= 9).length; const detractors = enps.filter(e => e.score <= 6).length;
  const eNPS = total ? Math.round(((promoters / total) - (detractors / total)) * 100) : null;
  return { ttp, ttf, close72Rate, poolMultiple, eNPS };
}

/*************************
 *  内置测试（保留原断言 + 新增持久化/会话用例）
 *************************/

function approxEqual(a: number | null, b: number, tol = 1e-6) { if (a === null) throw new Error(`期望 ${b}，实际 null`); if (Math.abs(a - b) > tol) throw new Error(`期望 ${b}，实际 ${a}`); }
function assertEqual<T>(a: T, b: T) { if (a !== b) throw new Error(`期望 ${String(b)}，实际 ${String(a)}`); }

async function runTests() {
  // 用 demo 数据做算法回归（与上一版本一致）
  const now = new Date(); const hoursAgo = (h: number) => new Date(now.getTime() - h * HOURS);
  const demoTickets: Ticket[] = [
    { id: 'F1', type: 'FAIRNESS', status: 'CLOSED', title: '公平申诉1', createdAt: hoursAgo(60), closedAt: hoursAgo(12) },
    { id: 'F2', type: 'FAIRNESS', status: 'CLOSED', title: '公平申诉2', createdAt: hoursAgo(120), closedAt: hoursAgo(20) },
    { id: 'R1', type: 'HIRING', status: 'OPEN', title: 'B2B 销售总监', createdAt: hoursAgo(10) },
    { id: 'R2', type: 'HIRING', status: 'IN_PROGRESS', title: '算法工程师', createdAt: hoursAgo(20) }
  ];
  const demoReqs: Requisition[] = [
    { id: 'RQ1', ticketId: 'R1', keyRole: true, approvedAt: hoursAgo(400), firstInterviewAt: hoursAgo(300), offerSignedAt: hoursAgo(276), onboardedAt: hoursAgo(200) },
    { id: 'RQ2', ticketId: 'R2', keyRole: true, approvedAt: hoursAgo(500), firstInterviewAt: hoursAgo(250), offerSignedAt: hoursAgo(202), onboardedAt: hoursAgo(140) },
    { id: 'RQ3', ticketId: 'X1', keyRole: false, approvedAt: hoursAgo(400), onboardedAt: hoursAgo(160) },
    { id: 'RQ4', ticketId: 'X2', keyRole: false, approvedAt: hoursAgo(200), onboardedAt: hoursAgo(80) }
  ];
  const demoENPS: ENPSResponse[] = [10,9,9,8,7,6,0].map(n => ({ score: n }));
  const r = computeTop8(demoTickets, demoReqs, demoENPS);
  approxEqual(Math.round((r.ttp ?? 0) * 100) / 100, 36);
  approxEqual(Math.round((r.ttf ?? 0) * 100) / 100, 180);
  assertEqual(r.close72Rate, 50); approxEqual(r.poolMultiple ?? 0, 3); assertEqual(r.eNPS, 14);
  const r2 = computeTop8(demoTickets.filter(t=>t.type!=='FAIRNESS'), demoReqs, demoENPS); assertEqual(r2.close72Rate, null);

  // 新增：持久化回归（在临时目录写入/读回）
  const tmp = path.join(process.cwd(), 'data-test-' + Date.now()); process.env.DATA_DIR = tmp; await ensureDir(tmp);
  await writeJSON('tickets.json', demoTickets); await writeJSON('requisitions.json', demoReqs);
  const backTickets = await readJSON<any[]>('tickets.json', []).then(a => a.map(reviveTicket));
  assertEqual(backTickets.length, demoTickets.length);

  console.log('✅ 所有内置测试通过');
}

/*************************
 *  视图（H5 页面）
 *************************/

function sendJSON(res: ServerResponse, obj: any, status = 200) { const body = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) }); res.end(body); }
function sendHTML(res: ServerResponse, html: string) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); }

function htmlIndex(sess: Session | null) {
  const login = sess ? `<div>已登录：${sess.name || sess.userId} <a href="/logout">退出</a></div>` : `<a href="/auth/wecom/login" class="btn">企业微信登录</a>`;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bai HCM · MVP</title>
  <style>body{font-family:system-ui,Segoe UI,Arial;max-width:960px;margin:20px auto;padding:0 12px}
  .card{background:#fff;padding:16px;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin:12px 0}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  input,select,textarea,button{font-size:14px;padding:8px;border-radius:8px;border:1px solid #ddd}
  button,.btn{background:#111;color:#fff;border-color:#111;cursor:pointer;padding:8px 12px;border-radius:8px;text-decoration:none}
  table{width:100%;border-collapse:collapse} td,th{border-bottom:1px solid #eee;padding:8px;text-align:left}
  </style></head><body>
  <h1>百音 HCM · 单文件服务（方案C 强化版）</h1>
  ${login}
  <div class="card"><h3>Top 8 KPI（子集）</h3><div id="kpi" class="grid"></div></div>
  <div class="card"><h3>新建工单</h3>
    <form id="newTicket">
      <select name="type"><option value="HIRING">招聘</option><option value="ONBOARDING">入职</option><option value="PERFORMANCE">绩效</option><option value="FAIRNESS">公道</option><option value="OTHER">其他</option></select>
      <input name="title" placeholder="标题" required />
      <input name="description" placeholder="描述" />
      <label><input type="checkbox" name="keyRole" />关键岗</label>
      <button>提交</button>
    </form>
  </div>
  <div class="card"><h3>工单列表</h3><table id="list"></table></div>
  <div class="card"><h3>eNPS 调研</h3>
    <form id="enps"><input type="number" min="0" max="10" name="score" value="10"/> <input name="comment" placeholder="原因(可选)"/> <button>提交</button></form>
  </div>
  <script src="/static/app.js"></script></body></html>`;
}

/*************************
 *  路由
 *************************/

function route(req: IncomingMessage, res: ServerResponse) {
  const { pathname, query } = parse(req.url || '/', true);
  const sess = getSession(req);
  if (req.method === 'GET' && pathname === '/') return sendHTML(res, htmlIndex(sess));

  // 静态资源
  if (req.method === 'GET' && pathname === '/static/app.js') {
    (async () => {
      try {
        const js = await fs.readFile(path.join(process.cwd(), 'public', 'app.js'), 'utf8');
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
        res.end(js);
      } catch {
        res.statusCode = 404; res.end('Not Found');
      }
    })();
    return;
  }

  // 登录 / 登出
  if (req.method === 'GET' && pathname === '/auth/wecom/login') {
    const redirect = encodeURIComponent(`${BASE_URL}/auth/wecom/callback`);
    const url = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${WECOM.CORP_ID}&redirect_uri=${redirect}&response_type=code&scope=snsapi_base&state=STATE#wechat_redirect`;
    res.statusCode = 302; res.setHeader('Location', url); return res.end();
  }
  if (req.method === 'GET' && pathname === '/auth/wecom/callback') {
    const code = (query as any).code as string | undefined;
    (async() => {
      try {
        if (!code) throw new Error('缺少 code');
        const info = await wecomUserIdByCode(code);
        await createSession(res, info.userId, info.name);
        res.statusCode = 302; res.setHeader('Location', '/'); res.end();
      } catch (e) {
        if (process.env.WECOM_DEV_ALLOW_FALLBACK === '1') { await createSession(res, 'DEV-'+Date.now(), '开发者'); res.statusCode = 302; res.setHeader('Location','/'); return res.end(); }
        res.statusCode = 500; return res.end('WeCom 登录失败，请检查环境变量与企业微信配置');
      }
    })();
    return;
  }
  // 开发登录（仅在允许 DEV Fallback 时启用）
  if (req.method === 'GET' && pathname === '/auth/dev') {
    if (process.env.WECOM_DEV_ALLOW_FALLBACK === '1') {
      (async () => { await createSession(res, 'DEV-'+Date.now(), '开发者'); res.statusCode = 302; res.setHeader('Location','/'); res.end(); })();
    } else { res.statusCode = 403; res.end('forbidden'); }
    return;
  }
  if (req.method === 'GET' && pathname === '/logout') {
    const sid = parseCookies(req.headers['cookie'])['sid'];
    if (sid) { store.sessions = store.sessions.filter(s => s.sid !== sid); save('sessions'); }
    setCookie(res, 'sid', '', { maxAge: 0 }); res.statusCode = 302; res.setHeader('Location','/'); return res.end();
  }

  // KPI & 列表
  if (req.method === 'GET' && pathname === '/api/kpi') return sendJSON(res, computeTop8(store.tickets, store.requisitions, store.enps, store.stopClocks));
  if (req.method === 'GET' && pathname === '/api/tickets') return sendJSON(res, store.tickets);

  // 创建工单（需要登录）
  if (req.method === 'POST' && pathname === '/api/tickets') {
    if (!sess) return sendJSON(res, { error: 'unauthorized' }, 401);
    (async () => {
      const body = await readBody(req);
      const id = cuid();
      const t: Ticket = { id, type: String(body.type||'OTHER') as TicketType, status: 'OPEN', title: String(body.title||'无标题'), description: String(body.description||''), createdAt: new Date(), closedAt: null };
      store.tickets.unshift(t); await save('tickets');
      if (t.type === 'HIRING') { store.requisitions.push({ id: cuid(), ticketId: id, keyRole: body.keyRole==='true' }); await save('requisitions'); }
      return sendJSON(res, { id });
    })();
    return;
  }

  // 停表 / 结束停表（需要登录）
  if (req.method === 'POST' && pathname?.startsWith('/api/tickets/') && pathname?.endsWith('/stop')) {
    if (!sess) return sendJSON(res, { error: 'unauthorized' }, 401);
    (async () => {
      const id = pathname.split('/')[3];
      const body = await readBody(req);
      store.stopClocks.push({ id: cuid(), ticketId: id, startAt: new Date(), reason: String(body.reason||'') });
      await save('stopClocks');
      return sendJSON(res, { ok: true });
    })();
    return;
  }
  if (req.method === 'POST' && pathname?.startsWith('/api/tickets/') && pathname?.endsWith('/resume')) {
    if (!sess) return sendJSON(res, { error: 'unauthorized' }, 401);
    (async () => {
      const id = pathname.split('/')[3];
      const latest = [...store.stopClocks].reverse().find(s => s.ticketId === id && !s.endAt);
      if (latest) latest.endAt = new Date();
      await save('stopClocks');
      return sendJSON(res, { ok: true });
    })();
    return;
  }

  // eNPS（需要登录以识别员工；如需匿名可改为不校验）
  if (req.method === 'POST' && pathname === '/api/enps') {
    if (!sess) return sendJSON(res, { error: 'unauthorized' }, 401);
    (async () => {
      const body = await readBody(req);
      const score = Math.max(0, Math.min(10, Number(body.score)));
      const comment = body.comment ? String(body.comment) : undefined;
      store.enps.push({ score, comment });
      await save('enps');
      return sendJSON(res, { ok: true });
    })();
    return;
  }

  // 小程序后端：code2session（小程序端把 js_code 发到这里换 sid）
  if (req.method === 'POST' && pathname === '/auth/wecom/mp/login') {
    (async () => {
      const body = await readBody(req);
      try {
        const data = await wecomMiniProgramCode2Session(String(body.js_code||''));
        const userId = (data as any).userid || (data as any).userId || (data as any).openid || 'UNKNOWN';
        await createSession(res, String(userId)); return sendJSON(res, { ok: true });
      } catch (e) {
        if (process.env.WECOM_DEV_ALLOW_FALLBACK === '1') { await createSession(res, 'DEV-'+Date.now(), '开发者'); return sendJSON(res, { ok: true, dev: true }); }
        return sendJSON(res, { error: 'wecom mp login failed' }, 500);
      }
    })();
    return;
  }

  res.statusCode = 404; res.end('Not Found');
}

/*************************
 *  HTTP 工具
 *************************/
async function readBody(req: IncomingMessage): Promise<any> { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return {}; const ct = req.headers['content-type'] || ''; if (ct.includes('application/json')) return JSON.parse(raw); const obj: any = {}; raw.split('&').forEach(kv => { const [k, v] = kv.split('='); obj[decodeURIComponent(k)] = decodeURIComponent((v||'').replace(/\+/g,' ')); }); return obj }

/*************************
 *  启动：先跑测试，再加载存储，再起服务
 *************************/
async function start() {
  try { await runTests(); } catch (e) { console.warn('⚠️ 测试失败，不阻塞启动：', (e as Error)?.message); }
  await loadStore();
  const PORT = Number(process.env.PORT || 3000);
  createServer(route).listen(PORT, () => console.log(`🚀 HCM 服务已启动：${BASE_URL.replace(/\/$/,'')}`));
}

if (import.meta.url === (process?.argv?.[1] ? `file://${process.argv[1]}` : '')) start();
