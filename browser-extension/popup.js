const $ = (s) => document.querySelector(s);
const msg = $('#msg');

function say(text, cls = '') {
  msg.textContent = text;
  msg.className = 'msg' + (cls ? ' ' + cls : '');
}

chrome.storage.local.get(
  { gopeedBase: 'http://127.0.0.1:16801', gopeedToken: '', saveDirName: 'Gopeed推送' },
  (s) => {
    $('#gopeedBase').value = s.gopeedBase;
    $('#gopeedToken').value = s.gopeedToken;
    $('#saveDirName').value = s.saveDirName;
  }
);

$('#save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    gopeedBase: $('#gopeedBase').value.trim() || 'http://127.0.0.1:16801',
    gopeedToken: $('#gopeedToken').value.trim(),
    saveDirName: $('#saveDirName').value.trim() || 'Gopeed推送',
  });
  say('保存好了喵~', 'ok');
});

$('#test').addEventListener('click', async () => {
  say('测试中…');
  // 先把当前输入存起来再测，避免测的是旧值
  await chrome.storage.local.set({
    gopeedBase: $('#gopeedBase').value.trim() || 'http://127.0.0.1:16801',
    gopeedToken: $('#gopeedToken').value.trim(),
  });
  const r = await chrome.runtime.sendMessage({ cmd: 'gopeedTest' });
  if (r && r.ok) say('连接成功喵！Gopeed 已就绪 🚀', 'ok');
  else say('失败：' + ((r && r.error) || '未知错误'), 'err');
});
