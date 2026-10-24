// Quark → Gopeed: background
// 职责：1) 兜底代发夸克请求(content script 跨域被拦时) 2) Gopeed REST 客户端
//       3) 捕获 file/download 响应的 set-cookie(__puus)，推给 Gopeed 时必须带上

const DEFAULTS = {
  gopeedBase: 'http://127.0.0.1:16801',
  gopeedToken: '',
  saveDirName: 'Gopeed推送',
};

// 夸克官方 PC 客户端 UA（直链接口按客户端放行，绕开网页端的 size limit）
const QUARK_CLIENT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';

// 会话级 DNR 规则：把发往夸克 download 接口的请求 UA 改成客户端 UA
// （浏览器 fetch 禁止自定义 UA，只能用 DNR 在网络层改写）
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [
    {
      id: 1,
      priority: 1,
      condition: {
        requestDomains: ['drive-pc.quark.cn', 'drive.quark.cn'],
        urlFilter: '*/file/download',
        resourceTypes: ['xmlhttprequest'],
      },
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'User-Agent', operation: 'set', value: QUARK_CLIENT_UA }],
      },
    },
  ],
}).catch((e) => console.warn('DNR rule failed', e));

// ---------- set-cookie 捕获 ----------
let lastDownloadCookie = '';

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.url.includes('/1/clouddrive/file/download')) {
      const sc = (details.responseHeaders || [])
        .filter((h) => h.name.toLowerCase() === 'set-cookie')
        .map((h) => h.value)
        .join('; ');
      if (sc) {
        lastDownloadCookie = sc;
        chrome.storage.session.set({ lastDownloadCookie: sc });
      }
    }
  },
  { urls: ['https://*.quark.cn/*'] },
  ['responseHeaders']
);

// ---------- 工具 ----------
async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return s;
}

async function quarkFetchFallback(url, options = {}) {
  // host_permissions 豁免 CORS；credentials include 带 cookie
  const resp = await fetch(url, { ...options, credentials: 'include' });
  const { status, headers } = resp;
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* ignore */ }
  return { status, headers: Object.fromEntries(headers.entries()), json, text };
}

function gopeedHeaders(token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) {
    // 兼容不同版本的认证头
    h['token'] = token;
    h['X-Api-Token'] = token;
  }
  return h;
}

async function gopeedRequest(path, options = {}) {
  const s = await getSettings();
  const base = s.gopeedBase.replace(/\/+$/, '');
  const resp = await fetch(base + path, {
    ...options,
    headers: { ...gopeedHeaders(s.gopeedToken), ...(options.headers || {}) },
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* ignore */ }
  if (!resp.ok) {
    const msg = (json && json.msg) || `HTTP ${resp.status}`;
    throw new Error(`Gopeed ${path}: ${msg}（检查地址/令牌/是否已开启 API）`);
  }
  if (json && typeof json.code === 'number' && json.code !== 0) {
    throw new Error(`Gopeed ${path}: ${json.msg || 'code ' + json.code}`);
  }
  return json ? json.data : json;
}

// ---------- Gopeed 操作 ----------
async function gopeedCreateTask({ url, filename, extraHeaders }) {
  const body = {
    req: {
      url,
      name: filename || undefined,
      extra: { header: extraHeaders }, // gopeed 的字段名是 header（单数）
    },
  };
  return gopeedRequest('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function gopeedTest() {
  const list = await gopeedRequest('/api/v1/tasks?page=1&size=1');
  return Array.isArray(list) ? { ok: true, tasks: list.length } : { ok: true };
}

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.cmd) {
        case 'quarkFetch': {
          // content script 的跨域兜底
          const r = await quarkFetchFallback(msg.url, msg.options || {});
          sendResponse({ ok: r.json !== null, status: r.status, json: r.json, text: r.text });
          break;
        }
        case 'getDownloadCookie': {
          if (!lastDownloadCookie) {
            const { lastDownloadCookie: c } = await chrome.storage.session.get('lastDownloadCookie');
            lastDownloadCookie = c || '';
          }
          sendResponse({ ok: true, cookie: lastDownloadCookie });
          break;
        }
        case 'gopeedPush': {
          const created = await gopeedCreateTask(msg.task);
          sendResponse({ ok: true, id: created && (created.id || created) });
          break;
        }
        case 'gopeedTest': {
          const r = await gopeedTest();
          sendResponse({ ok: true, ...r });
          break;
        }
        case 'getSettings': {
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown cmd' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // async sendResponse
});
