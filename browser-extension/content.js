// Quark → Gopeed: content script
// 浮动面板：我的网盘浏览+推送 / 分享页转存+推送
// 夸克接口封装参考开源项目 quark-auto-save（仅封装官方 API，需要你自己的登录态）

(() => {
  if (window.__quark2gopeed) return;
  window.__quark2gopeed = true;

  const COMMON_QS = { pr: 'ucpro', fr: 'pc' };
  // 夸克官方客户端 UA：拿直链的请求由 background 的 DNR 规则自动改写成它，
  // Gopeed 下载时也带它（与直链请求保持一致最稳）
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';

  // ---------------- 夸克 API ----------------
  // 通道1 drive-pc：网页端域名（对 pan.quark.cn 配了 CORS，同站带 cookie）
  // 通道2 drive：服务端域名（quark-auto-save 服务端验证过），由 background 代发豁免 CORS
  const Q_CH1 = 'https://drive-pc.quark.cn';
  const Q_CH2 = 'https://drive.quark.cn';

  async function qfetch(method, path, { params = {}, body } = {}, allowedStatuses = []) {
    const qs = new URLSearchParams({ ...COMMON_QS, ...params });
    const urlFor = (base) => `${base}/1/clouddrive${path}?${qs.toString()}`;
    const options = {
      method,
      credentials: 'include', // 带登录 cookie
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) options.body = JSON.stringify(body);

    let json = null;
    let lastErr = null;
    // 通道1：content script 直接请求
    try {
      const resp = await fetch(urlFor(Q_CH1), options);
      json = await resp.json().catch(() => null);
    } catch (e) {
      lastErr = e; // CORS/网络层失败
    }
    // 通道2：疑似鉴权/权限拒绝或网络失败时，走 background + 服务端域名
    if (!json || json.status === 401 || json.status === 403) {
      try {
        const r = await chrome.runtime.sendMessage({ cmd: 'quarkFetch', url: urlFor(Q_CH2), options });
        if (r && r.json) json = r.json;
        else if (r && r.error) lastErr = new Error(r.error);
      } catch (e) {
        lastErr = e;
      }
    }
    if (!json) throw new Error('夸克接口无响应：' + (lastErr || '网络异常') + '（确认已登录 pan.quark.cn）');
    // 原样透传夸克错误码，不再猜测原因
    if (json.status !== 200 && !allowedStatuses.includes(json.status)) {
      throw new Error(`夸克 status=${json.status}：${json.message || json.msg || '未知'}`);
    }
    return json;
  }

  const api = {
    lsDir: (pdir_fid, page = 1) =>
      qfetch('GET', '/file/sort', {
        params: { pdir_fid, _page: page, _size: 100, _fetch_total: 1, _sort: 'file_type:asc,file_name:asc' },
      }),
    download: (fids) => qfetch('POST', '/file/download', { body: { fids } }),
    mkdir: (name) =>
      qfetch('POST', '/file', {
        body: { pdir_fid: '0', file_name: name, dir_path: '', dir_init_lock: false },
      }),
    shareToken: (pwd_id, passcode) =>
      qfetch('POST', '/share/sharepage/token',
        { params: { app: 'clouddrive' }, body: { pwd_id, passcode } }, [410002]),
    shareDetail: (pwd_id, stoken, pdir_fid) =>
      qfetch('GET', '/share/sharepage/detail', {
        params: { pwd_id, stoken, pdir_fid, _page: 1, _size: 100, _fetch_total: 1, _sort: 'file_type:asc,file_name:asc' },
      }),
    shareSave: (o) =>
      qfetch('POST', '/share/sharepage/save', {
        params: { __dt: 1200, __t: Date.now(), app: 'clouddrive' },
        body: {
          fid_list: o.fids,
          fid_token_list: o.tokens,
          to_pdir_fid: o.toPdirFid,
          pwd_id: o.pwdId,
          stoken: o.stoken,
          pdir_fid: '0',
          scene: 'link',
        },
      }),
    queryTask: (task_id) =>
      qfetch('GET', '/task', { params: { task_id, retry_index: Math.floor(Math.random() * 10) } }),
  };

  const bg = {
    push: (task) => chrome.runtime.sendMessage({ cmd: 'gopeedPush', task }),
    cookie: () => chrome.runtime.sendMessage({ cmd: 'getDownloadCookie' }),
    settings: () => chrome.runtime.sendMessage({ cmd: 'getSettings' }),
  };

  // ---------------- 业务流程 ----------------
  function detectMode() {
    const m = location.pathname.match(/^\/s\/([a-z0-9]+)/i);
    if (m) return { mode: 'share', pwdId: m[1] };
    return { mode: 'drive' };
  }

  async function ensureSaveDir(name) {
    const res = await api.lsDir('0');
    const found = (res.data && res.data.list || []).find((f) => f.dir && f.file_name === name);
    if (found) return found.fid;
    const made = await api.mkdir(name);
    if (made.data && made.data.fid) return made.data.fid;
    // 建完再查一次兜底
    const res2 = await api.lsDir('0');
    const f2 = (res2.data && res2.data.list || []).find((f) => f.dir && f.file_name === name);
    if (f2) return f2.fid;
    throw new Error('创建转存目录失败');
  }

  async function waitTask(taskId) {
    for (let i = 0; i < 20; i++) {
      const r = await api.queryTask(taskId);
      const d = r.data || {};
      if (d.status === 2) return (d.save_as && d.save_as.save_as_top_fids) || [];
      if (d.status === 3 || d.status === 4) throw new Error('转存任务失败：' + (d.message || 'status ' + d.status));
      await new Promise((res) => setTimeout(res, 600));
    }
    throw new Error('转存任务超时');
  }

  async function pushFiles(fids, names, onProgress) {
    const { settings } = await bg.settings();
    const okList = [];
    const failList = [];
    for (let i = 0; i < fids.length; i++) {
      try {
        onProgress(`获取直链 ${i + 1}/${fids.length}：${names[i] || ''}`);
        const dl = await api.download([fids[i]]);
        const info = (dl.data && dl.data[0]) || {};
        const url = info.download_url || info.direct_url;
        if (!url) throw new Error('未取到直链（接口返回异常）');
        const { cookie } = await bg.cookie();
        const headers = {
          'User-Agent': UA,
          Referer: 'https://pan.quark.cn/',
        };
        if (cookie) headers.Cookie = cookie; // __puus 下载鉴权
        onProgress(`推送 Gopeed：${names[i] || 'file'}`);
        const r = await bg.push({
          url,
          filename: names[i],
          extraHeaders: headers,
        });
        if (!r || !r.ok) throw new Error((r && r.error) || 'Gopeed 推送失败');
        okList.push(names[i] || url);
      } catch (e) {
        let msg = String(e.message || e);
        if (/download file size limit/i.test(msg)) {
          msg = '超过夸克非会员直链大小限制（官方会员墙，一般>4GB 需开 SVIP；网页端下载同样受限）';
        }
        failList.push(`${names[i] || '文件'}：${msg}`);
      }
    }
    return { okList, failList };
  }

  // ---------------- UI（Shadow DOM） ----------------
  const host = document.createElement('div');
  host.id = 'q2g-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  const CSS = `
    :host { all: initial; font-family: "Segoe UI","Microsoft YaHei",sans-serif; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .fab {
      position: fixed; right: 24px; bottom: 96px; z-index: 2147483646;
      width: 52px; height: 52px; border-radius: 50%;
      background: linear-gradient(135deg,#e07085,#c4586d);
      color: #fff; font-size: 24px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 14px rgba(196,88,109,.45);
      transition: transform .15s;
      user-select: none;
    }
    .fab:hover { transform: scale(1.08); }
    .panel {
      position: fixed; right: 24px; bottom: 160px; z-index: 2147483646;
      width: 380px; max-height: 520px;
      background: #fffafc; border-radius: 14px; overflow: hidden;
      box-shadow: 0 10px 40px rgba(60,30,40,.25);
      display: none; flex-direction: column;
      border: 1px solid #f2dfe2;
    }
    .panel.open { display: flex; }
    .hd {
      padding: 12px 14px 10px; background: linear-gradient(135deg,#e07085,#c4586d); color:#fff;
    }
    .hd .t { font-size: 14px; font-weight: 700; display:flex; align-items:center; gap:6px; }
    .hd .mode { font-size: 11px; opacity:.9; margin-top:2px; }
    .hd .close { margin-left:auto; cursor:pointer; opacity:.85; font-size:16px; }
    .bar { display:flex; gap:8px; align-items:center; padding:8px 12px; background:#fdf1f3; font-size:11px; }
    .bar .crumb { color:#9a6b76; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
    .bar button {
      border:none; border-radius:6px; padding:3px 9px; cursor:pointer; font-size:11px;
      background:#fff; color:#c4586d;
    }
    .list { flex:1; overflow-y:auto; padding:6px 10px; min-height:180px; max-height:320px; }
    .empty { color:#b9a8ae; font-size:12px; text-align:center; padding:40px 0; line-height:1.9; }
    .item { display:flex; align-items:center; gap:8px; padding:7px 8px; border-radius:8px; }
    .item:hover { background:#fdf3f5; }
    .item .ic { width:20px; text-align:center; font-size:14px; }
    .item .nm { flex:1; font-size:12.5px; color:#3a3040; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .item .sz { font-size:10.5px; color:#b9a8ae; flex:none; }
    .item.dir { cursor:pointer; }
    .item input { accent-color:#e07085; }
    .ft { padding:10px 12px; border-top:1px solid #f2dfe2; display:flex; gap:8px; }
    .ft button {
      flex:1; border:none; border-radius:9px; padding:8px 0; font-size:12.5px; cursor:pointer; font-weight:700;
    }
    .ft .push { background:linear-gradient(135deg,#e07085,#c4586d); color:#fff; }
    .ft .push:disabled { opacity:.5; cursor:not-allowed; }
    .ft .selall { background:#f6e7ea; color:#c4586d; }
    .status { font-size:11px; padding:7px 12px 9px; color:#9a6b76; min-height:26px; }
    .status.ok { color:#3f8f57; }
    .status.err { color:#c04545; }
    .pwd {
      display:none; gap:6px; padding:8px 12px 0;
    }
    .pwd input {
      flex:1; border:1px solid #f2dfe2; border-radius:7px; padding:5px 8px; font-size:12px;
    }
    .pwd button { border:none; border-radius:7px; background:#f6e7ea; color:#c4586d; padding:5px 10px; cursor:pointer; }
  `;

  root.innerHTML = `
    <style>${CSS}</style>
    <div class="fab" title="推送到 Gopeed">🐾</div>
    <div class="panel">
      <div class="hd">
        <div class="t">🐾 夸克 → Gopeed <span class="close">✕</span></div>
        <div class="mode"></div>
      </div>
      <div class="pwd"><input placeholder="提取码（没有就留空）" /><button>进入</button></div>
      <div class="bar"><span class="crumb"></span><button class="up" title="返回上级" style="visibility:hidden">⬆ 上级</button><button class="refresh">刷新</button></div>
      <div class="list"><div class="empty">加载中喵…</div></div>
      <div class="ft"><button class="selall">全选</button><button class="push">🚀 推送到 Gopeed</button></div>
      <div class="status"></div>
    </div>
  `;

  const $ = (sel) => root.querySelector(sel);
  const fab = $('.fab'), panel = $('.panel'), listBox = $('.list'), statusEl = $('.status');

  const state = {
    mode: 'drive',
    pwdId: '',
    stoken: '',
    pdirFid: '0',
    stack: [],           // 我的网盘目录栈 [{fid,name}]
    shareStack: [],      // 分享目录栈 [{fid,name}]
    files: [],           // 当前列表 [{fid, name, dir, size, token?}]
    checked: new Set(),
  };

  function setStatus(text, cls = '') {
    statusEl.textContent = text;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  function fmtSize(n) {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
  }

  function renderList() {
    listBox.innerHTML = '';
    if (!state.files.length) {
      listBox.innerHTML = '<div class="empty">这里没有文件喵~</div>';
    }
    for (const f of state.files) {
      const div = document.createElement('div');
      div.className = 'item' + (f.dir ? ' dir' : '');
      const sizeStr = f.dir ? '' : fmtSize(f.size);
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.title = f.name;
      nm.textContent = f.name;
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = sizeStr;
      const ic = document.createElement('span');
      ic.className = 'ic';
      ic.textContent = f.dir ? '📁' : '📄';
      div.append(ic, nm, sz);
      // 我的网盘：文件夹点击进入（download 接口不支持目录，不可勾选）
      // 分享页：文件夹既可点击进入，也可勾选整体转存
      if (f.dir) {
        if (state.mode === 'share') {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = state.checked.has(f.fid);
          cb.addEventListener('change', (e) => {
            e.stopPropagation();
            cb.checked ? state.checked.add(f.fid) : state.checked.delete(f.fid);
            setStatus(`已选 ${state.checked.size} 项`);
          });
          div.prepend(cb);
          div.addEventListener('click', (e) => {
            if (e.target === cb) return;
            enterDir(f);
          });
          const go = document.createElement('span');
          go.className = 'sz';
          go.textContent = '进入 ›';
          go.style.cursor = 'pointer';
          go.style.color = '#e07085';
          div.replaceChild(go, sz);
        } else {
          div.addEventListener('click', () => enterDir(f));
        }
      } else {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.checked.has(f.fid);
        cb.addEventListener('change', () => {
          cb.checked ? state.checked.add(f.fid) : state.checked.delete(f.fid);
          setStatus(`已选 ${state.checked.size} 项`);
        });
        div.addEventListener('click', (e) => {
          if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
        });
        div.prepend(cb);
      }
      listBox.appendChild(div);
    }
    const crumbEl = $('.crumb');
    if (state.mode === 'share') {
      const path = ['分享'].concat(state.shareStack.map((s) => s.name));
      crumbEl.textContent = path.join(' / ');
    } else {
      crumbEl.textContent = ['根目录'].concat(state.stack.map((s) => s.name)).join(' / ');
    }
    $('.up').style.visibility = state.stack.length || state.shareStack.length ? 'visible' : 'hidden';
  }

  async function loadDriveList() {
    setStatus('加载目录…');
    const res = await api.lsDir(state.pdirFid);
    state.files = ((res.data && res.data.list) || []).map((f) => ({
      fid: f.fid, name: f.file_name, dir: !!f.dir, size: f.size,
    }));
    renderList();
    setStatus(`共 ${state.files.length} 项，勾选文件后推送喵`);
  }

  async function loadShareList(pdirFid = '0') {
    setStatus('读取分享…');
    const passcode = ($('.pwd input') || {}).value || '';
    if (!state.stoken) {
      const t = await api.shareToken(state.pwdId, passcode);
      if (t.status === 410002) { // 需要提取码
        $('.pwd').style.display = 'flex';
        throw new Error('这个分享需要提取码，填好后点"进入"');
      }
      if (t.status !== 200 || !t.data) throw new Error('分享已失效或需要提取码');
      state.stoken = t.data.stoken;
    }
    const d = await api.shareDetail(state.pwdId, state.stoken, pdirFid);
    state.files = ((d.data && d.data.list) || []).map((f) => ({
      fid: f.fid, name: f.file_name, dir: !!f.dir, size: f.size, token: f.share_fid_token,
    }));
    renderList();
    setStatus(`当前目录 ${state.files.length} 项：点"进入"钻取文件夹，勾选后转存推送喵`);
  }

  async function enterDir(f) {
    if (state.mode === 'drive') {
      state.stack.push({ fid: state.pdirFid, name: f.name });
      state.pdirFid = f.fid;
      await loadDriveList();
    } else {
      const cur = state.shareStack.length
        ? state.shareStack[state.shareStack.length - 1].fid
        : '0';
      state.shareStack.push({ fid: cur, name: f.name });
      await loadShareList(f.fid);
    }
  }

  async function goUp() {
    if (state.mode === 'drive') {
      if (!state.stack.length) return;
      state.pdirFid = state.stack.pop().fid;
      await loadDriveList();
    } else {
      if (!state.shareStack.length) return;
      const parent = state.shareStack.pop().fid;
      await loadShareList(parent);
    }
  }

  // 递归收集目录下的所有文件（限深限总量，防止失控）
  async function collectFiles(fid, prefix = '', depth = 0, out = []) {
    if (depth > 5 || out.length > 500) return out;
    const res = await api.lsDir(fid);
    for (const f of (res.data && res.data.list) || []) {
      const name = prefix ? `${prefix}/${f.file_name}` : f.file_name;
      if (f.dir) await collectFiles(f.fid, name, depth + 1, out);
      else out.push({ fid: f.fid, name });
    }
    return out;
  }

  async function onPush() {
    const checkedFiles = state.files.filter((f) => state.checked.has(f.fid));
    if (!checkedFiles.length) { setStatus('先勾选要下载的文件或文件夹喵', 'err'); return; }
    $('.push').disabled = true;
    try {
      let targets = []; // [{fid, name}]
      if (state.mode === 'share') {
        const { settings } = await bg.settings();
        setStatus('准备转存目录…');
        const dirFid = await ensureSaveDir(settings.saveDirName || 'Gopeed推送');
        setStatus(`转存 ${checkedFiles.length} 项…`);
        const sv = await api.shareSave({
          fids: checkedFiles.map((p) => p.fid),
          tokens: checkedFiles.map((p) => p.token),
          toPdirFid: dirFid,
          pwdId: state.pwdId,
          stoken: state.stoken,
        });
        const taskId = sv.data && (sv.data.task_id || sv.data);
        const topFids = taskId ? await waitTask(taskId) : [];
        // save_as_top_fids 与 fid_list 顺序对应；目录递归展开成文件
        for (let i = 0; i < checkedFiles.length; i++) {
          const f = checkedFiles[i];
          const newFid = Array.isArray(topFids) && topFids[i] ? topFids[i] : f.fid;
          if (f.dir) {
            setStatus(`展开文件夹：${f.name}`);
            const inner = await collectFiles(newFid, f.name);
            targets.push(...inner);
          } else {
            targets.push({ fid: newFid, name: f.name });
          }
        }
      } else {
        targets = checkedFiles.filter((f) => !f.dir);
        if (targets.length < checkedFiles.length) {
          setStatus('文件夹已忽略（进入文件夹后勾选文件），3 秒后开始推送…');
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!targets.length) { setStatus('没有可下载的文件喵', 'err'); return; }
      const { okList, failList } = await pushFiles(
        targets.map((t) => t.fid),
        targets.map((t) => t.name),
        setStatus
      );
      if (okList.length && !failList.length) {
        setStatus(`完成喵！已推送 ${okList.length} 个任务到 Gopeed 🚀`, 'ok');
      } else if (okList.length) {
        setStatus(`推送 ${okList.length} 个成功；${failList.length} 个失败：${failList[0]}${failList.length > 1 ? ' 等' : ''}`, 'err');
      } else {
        setStatus(failList.join('；'), 'err');
      }
    } catch (e) {
      setStatus(String(e.message || e), 'err');
    } finally {
      $('.push').disabled = false;
    }
  }

  // ---------------- 事件 ----------------
  fab.addEventListener('click', async () => {
    const open = panel.classList.toggle('open');
    if (open) {
      const det = detectMode();
      Object.assign(state, {
        mode: det.mode, pwdId: det.pwdId || '', stoken: '',
        pdirFid: '0', stack: [], shareStack: [], checked: new Set(),
      });
      $('.mode').textContent = det.mode === 'share' ? '分享页 · 转存并推送' : '我的网盘 · 直链推送';
      try {
        if (det.mode === 'share') await loadShareList(); else await loadDriveList();
      } catch (e) {
        setStatus(String(e.message || e), 'err');
        if (state.mode === 'drive') listBox.innerHTML = '<div class="empty">加载失败，请确认已登录夸克网盘喵</div>';
      }
    }
  });
  $('.close').addEventListener('click', () => panel.classList.remove('open'));
  $('.up').addEventListener('click', async () => {
    try { await goUp(); } catch (e) { setStatus(String(e.message || e), 'err'); }
  });
  $('.refresh').addEventListener('click', async () => {
    try {
      if (state.mode === 'share') {
        const cur = state.shareStack.length ? state.shareStack[state.shareStack.length - 1].fid : '0';
        await loadShareList(cur);
      } else {
        await loadDriveList();
      }
    } catch (e) { setStatus(String(e.message || e), 'err'); }
  });
  $('.selall').addEventListener('click', () => {
    // 我的网盘：只选文件；分享页：文件+文件夹都可选
    const selectable = state.files.filter((f) => state.mode === 'share' || !f.dir);
    if (state.checked.size >= selectable.length) state.checked.clear();
    else selectable.forEach((f) => state.checked.add(f.fid));
    renderList();
    setStatus(`已选 ${state.checked.size} 项`);
  });
  $('.push').addEventListener('click', onPush);
  $('.pwd button') && $('.pwd button').addEventListener('click', async () => {
    try { await loadShareList(); } catch (e) { setStatus(String(e.message || e), 'err'); }
  });
})();
