/**
 * Gopeed 夸克网盘解析扩展（柚子版）
 * 参考并致谢: github.com/muyan556/gopeed-extension-quark (MIT)
 * 参考接口封装: github.com/Cp0204/quark-auto-save
 *
 * 用法: 把夸克分享链接粘贴进 Gopeed 新建任务 → 自动列出全部文件 → 勾选下载
 * 链接带提取码: 在链接后加 ?pw=提取码
 * 链接指向子目录: 用网页打开到那个目录后复制带 #/list/share/xxx 的完整链接
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';
const DRIVE = 'https://drive-pc.quark.cn';
const PAGE = 100;
const BATCH = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = {
  info: (m) => gopeed.logger.info('[yuzu] ' + m),
  warn: (m) => gopeed.logger.warn('[yuzu] ' + m),
};

function fail(msg) {
  // gopeed 会把 MessageError 的消息展示给用户
  try {
    throw new MessageError(msg);
  } catch (e) {
    if (e instanceof MessageError) throw e;
    throw new Error(msg);
  }
}

// ---------- Cookie ----------
function getCookie() {
  const fromSettings = (gopeed.settings.cookie || '').trim();
  if (fromSettings) {
    if (gopeed.storage.get('cookie') !== fromSettings) {
      gopeed.storage.set('cookie', fromSettings); // 设置更新后同步到运行缓存
    }
  }
  const c = gopeed.storage.get('cookie') || fromSettings;
  if (!c) fail('还没配置 Cookie 喵！请到 扩展设置 → 夸克 Cookie 粘贴浏览器里复制的完整 Cookie');
  return c;
}

// ---------- 分享链接解析 ----------
function parseShareUrl(raw) {
  const clean = String(raw || '').replace(/\[.*?\]/g, '').trim();
  let pwdId = '', passcode = '', pdirFid = '';
  const idm = clean.match(/\/s\/([a-zA-Z0-9]+)/);
  if (idm) pwdId = idm[1];
  else if (clean.length > 10 && /^[a-zA-Z0-9]+$/.test(clean)) pwdId = clean;
  if (!pwdId) fail('无法从链接解析出分享 ID 喵');
  const pwm = clean.match(/[?&](pwd|password|pw)=([a-zA-Z0-9]{4})/i);
  if (pwm) passcode = pwm[2];
  const dirm = clean.match(/#\/list\/share\/([a-zA-Z0-9]+)/);
  if (dirm) pdirFid = dirm[1];
  return { pwdId, passcode, pdirFid };
}

// ---------- 请求 ----------
function isOk(j) {
  if (typeof j.status === 'number') return j.status === 200;
  if (typeof j.code === 'number') return j.code === 0;
  return false;
}

async function req(url, method, body) {
  const resp = await fetch(url, {
    method,
    headers: {
      Cookie: getCookie(),
      'User-Agent': UA,
      Referer: 'https://pan.quark.cn/',
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await resp.json(); } catch (e) { /* 非 JSON */ }
  if (j && (j.code === 40001 || j.code === 10000 || j.status === 401)) {
    fail('Cookie 已失效喵！重新登录 pan.quark.cn 并更新扩展设置里的 Cookie');
  }
  if (!j) fail('夸克接口返回异常（HTTP ' + resp.status + '），稍后重试喵');
  return j;
}

const qs = (obj) => Object.keys(obj).map((k) => `${k}=${encodeURIComponent(obj[k])}`).join('&');
const base = { pr: 'ucpro', fr: 'pc', app: 'clouddrive' };

// ---------- 夸克 API ----------
async function apiGetToken(pwdId, passcode) {
  const j = await req(`${DRIVE}/1/clouddrive/share/sharepage/token?${qs(base)}`, 'POST', { pwd_id: pwdId, passcode });
  if (j.status === 410002 || (j.data && !j.data.stoken)) {
    fail('分享需要提取码或提取码错误喵（在链接后面加 ?pw=提取码 再试）');
  }
  if (!isOk(j) || !j.data) fail('获取分享信息失败：' + (j.message || j.msg || '链接可能已失效'));
  return { stoken: j.data.stoken, title: j.data.pdir_name || j.data.title || '夸克分享' };
}

async function apiGetDetailPage(pwdId, stoken, pdirFid, page) {
  const j = await req(`${DRIVE}/1/clouddrive/share/sharepage/detail?${qs({
    ...base, pwd_id: pwdId, stoken, pdir_fid: pdirFid || '',
    _page: page, _size: PAGE, _fetch_total: 1, _sort: 'file_type:asc,file_name:asc',
  })}`, 'GET');
  if (!isOk(j)) fail('读取分享文件失败：' + (j.message || j.msg || ''));
  const meta = j.data.metadata || j.data._meta || {};
  return { list: j.data.list || [], total: typeof meta._total === 'number' ? meta._total : (j.data.list || []).length };
}

async function apiSaveShare(pwdId, stoken, fids, tokens) {
  const j = await req(`${DRIVE}/1/clouddrive/share/sharepage/save?${qs({
    ...base, __dt: 1200, __t: Date.now(),
  })}`, 'POST', {
    fid_list: fids, fid_token_list: tokens, to_pdir_fid: '0',
    pwd_id: pwdId, stoken, pdir_fid: '0', scene: 'link',
  });
  if (!isOk(j)) fail('转存失败：' + (j.message || j.msg || '网盘空间满或触发风控'));
  const sync = j.data && j.data.task_resp && j.data.task_resp.data && j.data.task_resp.data.save_as;
  const syncFids = sync && (sync.save_as_top_fids || sync.save_as_select_top_fids);
  if (j.data && j.data.task_sync && Array.isArray(syncFids) && syncFids.length) {
    return syncFids;
  }
  const taskId = j.data && j.data.task_id;
  if (!taskId) fail('转存未返回任务喵');
  // 轮询
  for (let i = 0; i < 100; i++) {
    await sleep(1000);
    const t = await req(`${DRIVE}/1/clouddrive/task?${qs({ pr: 'ucpro', fr: 'pc', task_id: taskId, retry_index: i % 10, __dt: Date.now() })}`, 'GET');
    const d = t.data || {};
    if (d.status === 2 || d.status === 1) {
      const f = d.save_as && (d.save_as.save_as_top_fids || d.save_as.save_as_select_top_fids);
      if (Array.isArray(f) && f.length) return f;
      if (d.status === 2) fail('转存完成但没拿到文件列表，可能空间不足喵');
    }
    if (d.status === 3) fail('转存失败：网盘空间满或触发风控');
  }
  fail('转存轮询超时喵');
}

async function apiDownloadLinks(fids) {
  const out = [];
  for (let i = 0; i < fids.length; i += BATCH) {
    const j = await req(`${DRIVE}/1/clouddrive/file/download?${qs({ pr: 'ucpro', fr: 'pc' })}`, 'POST', { fids: fids.slice(i, i + BATCH) });
    if (j.code === 23018) fail('触发夸克风控(23018)，稍等几分钟再试喵');
    if (j.code !== 0 && j.status !== 200) fail('获取直链失败：' + (j.message || j.msg || ''));
    if (Array.isArray(j.data)) out.push(...j.data);
  }
  return out;
}

async function apiDelete(fids) {
  try {
    await req(`${DRIVE}/1/clouddrive/file/delete?${qs({ pr: 'ucpro', fr: 'pc' })}`, 'POST', { action_type: 2, filelist: fids, exclude_fids: [] });
  } catch (e) {
    log.warn('清理转存文件失败（忽略）: ' + e.message);
  }
}

async function apiCapacity() {
  try {
    const j = await req(`${DRIVE}/1/clouddrive/member?${qs({ pr: 'ucpro', fr: 'pc', fetch_subscribe: 'true', fetch_identity: 'true' })}`, 'GET');
    const d = j.data;
    if (d && typeof d.total_capacity === 'number') return Math.max(0, d.total_capacity - (d.use_capacity || 0));
  } catch (e) { /* 忽略 */ }
  return -1; // 未知
}

// ---------- 递归扫描 ----------
async function collectAll(pwdId, stoken, pdirFid, prefix, maxCount, counter, out) {
  let page = 1;
  for (;;) {
    const { list, total } = await apiGetDetailPage(pwdId, stoken, pdirFid, page);
    for (const item of list) {
      const name = prefix ? `${prefix}/${item.file_name}` : item.file_name;
      if (item.dir) {
        await collectAll(pwdId, stoken, item.fid, name, maxCount, counter, out);
      } else {
        out.push({ fid: item.fid, token: item.share_fid_token, name: item.file_name, path: prefix, size: item.size || 0 });
        counter.n++;
      }
      if (maxCount > 0 && counter.n >= maxCount) {
        log.warn(`已达最大文件数 ${maxCount}，停止扫描`);
        return out;
      }
    }
    if (page * PAGE >= total || list.length < PAGE) break;
    page++;
  }
  return out;
}

// ---------- 事件 ----------
gopeed.events.onResolve(async (ctx) => {
  log.info('夸克解析开始: ' + ctx.req.url);

  const { pwdId, passcode, pdirFid } = parseShareUrl(ctx.req.url);
  getCookie(); // 提前校验

  log.info('1/5 获取分享信息…');
  const { stoken, title } = await apiGetToken(pwdId, passcode);

  log.info('2/5 递归扫描文件…');
  const maxCount = parseInt(gopeed.settings.max_file_count, 10) || 0;
  const allFiles = await collectAll(pwdId, stoken, pdirFid, '', maxCount, { n: 0 }, []);
  if (!allFiles.length) fail('分享里没有可下载的文件喵');
  log.info(`共扫描到 ${allFiles.length} 个文件`);

  log.info('3/5 检查网盘空间…');
  const capacity = await apiCapacity();
  const shouldDelete = (gopeed.settings.delete_file || '1') === '1';
  const safeBuffer = 100 * 1024 * 1024;
  const maxChunk = capacity !== -1 ? Math.max(0, capacity - safeBuffer) : Infinity;

  // 按大小升序，方便分块 + 跳过放不下的大文件
  allFiles.sort((a, b) => a.size - b.size);
  const skipped = [];
  const usable = [];
  for (const f of allFiles) {
    if (f.size > maxChunk) skipped.push(f);
    else usable.push(f);
  }
  if (!usable.length) fail(`网盘剩余空间太小（${(capacity / 1073741824).toFixed(2)}GB），最小的文件也放不下喵；请先清理网盘`);

  // 分块：每块总大小不超过可用空间（配合边转边删，大分享也能下）
  const chunks = [];
  let cur = [], curSize = 0;
  for (const f of usable) {
    if (curSize + f.size > maxChunk && cur.length) { chunks.push(cur); cur = []; curSize = 0; }
    cur.push(f); curSize += f.size;
  }
  if (cur.length) chunks.push(cur);
  log.info(`4/5 分 ${chunks.length} 批转存提取直链（边转边删: ${shouldDelete ? '开' : '关'}）…`);

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    log.info(`  第 ${i + 1}/${chunks.length} 批（${chunk.length} 个文件）…`);
    try {
      const savedFids = await apiSaveShare(pwdId, stoken, chunk.map((f) => f.fid), chunk.map((f) => f.token));
      const links = await apiDownloadLinks(savedFids);
      const used = new Set();
      // 直链结果与原文件按 大小+名字 匹配（download 接口不保序）
      for (const d of links) {
        if (!d.download_url) continue;
        let idx = chunk.findIndex((o, k) => !used.has(k) && o.size === d.size && (o.name === d.file_name || d.file_name.indexOf(o.name.replace(/\.[^/.]+$/, '')) >= 0));
        if (idx === -1) idx = chunk.findIndex((o, k) => !used.has(k) && o.size === d.size);
        if (idx === -1) idx = chunk.findIndex((o, k) => !used.has(k));
        if (idx !== -1) {
          used.add(idx);
          const o = chunk[idx];
          results.push({ name: o.name, size: d.size || o.size, path: o.path, url: d.download_url, fid: savedFids[idx] || o.fid });
        }
      }
      if (shouldDelete) await apiDelete(savedFids);
    } catch (e) {
      log.warn(`  第 ${i + 1} 批失败跳过: ${e.message}`);
    }
  }

  if (!results.length) fail('没能取得任何直链喵：检查 Cookie 有效性 / 网盘空间 / 分享是否失效');
  log.info(`5/5 解析成功：${results.length} 个文件（${skipped.length} 个因超过网盘剩余空间被跳过）`);

  ctx.res = {
    name: title + (skipped.length ? `（跳过${skipped.length}个大文件）` : ''),
    files: results.map((r) => ({
      name: r.name,
      size: r.size,
      path: r.path,
      req: {
        url: r.url,
        labels: { type: 'quark', fid: r.fid },
        extra: {
          header: {
            'User-Agent': UA,
            Cookie: getCookie(),
            Referer: 'https://pan.quark.cn/',
          },
        },
      },
    })),
  };
});

gopeed.events.onStart(async (ctx) => {
  const { req } = ctx.task.meta;
  if (!req || !req.labels || req.labels.type !== 'quark') return;
  try {
    // 直链带 Expires 参数，过期则用 fid 换新链接
    let expired = true;
    try {
      const exp = new URL(req.url).searchParams.get('Expires');
      if (exp && Date.now() < parseInt(exp, 10) * 1000) {
        const r = await fetch(req.url, { method: 'GET', headers: { Range: 'bytes=0-0', ...(req.extra && req.extra.header) } });
        expired = r.status < 200 || r.status >= 400;
      }
    } catch (e) { /* 判定过期 */ }
    if (expired && req.labels.fid) {
      log.info('直链已过期，刷新中…');
      const fresh = await apiDownloadLinks([req.labels.fid]);
      if (fresh[0] && fresh[0].download_url) req.url = fresh[0].download_url;
    }
  } catch (e) {
    log.warn('链接刷新失败（继续用原链接）: ' + e.message);
  }
});
