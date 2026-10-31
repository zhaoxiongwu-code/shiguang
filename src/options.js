import { loadSettings, saveSettings, parseRepoUrl, parseTags } from './shared/settings.js';

const $ = (id) => document.getElementById(id);

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function readForm() {
  const repoParsed = parseRepoUrl($('repoUrl').value);
  return {
    token: $('token').value.trim(),
    owner: repoParsed ? repoParsed.owner : '',
    repo: repoParsed ? repoParsed.repo : '',
    branch: $('branch').value.trim() || 'main',
    rootFolder: $('rootFolder').value.trim(),
    saveImages: $('saveImages').checked,
    saveHtml: $('saveHtml').checked,
    defaultTags: parseTags($('defaultTags').value),
  };
}

function fillForm(s) {
  $('token').value = s.token || '';
  $('repoUrl').value = s.owner && s.repo ? `https://github.com/${s.owner}/${s.repo}` : '';
  $('branch').value = s.branch || 'main';
  $('rootFolder').value = s.rootFolder || '';
  $('saveImages').checked = s.saveImages !== false;
  $('saveHtml').checked = s.saveHtml !== false;
  $('defaultTags').value = (s.defaultTags || []).join(', ');
}

async function init() {
  const s = await loadSettings();
  fillForm(s);

  $('toggleToken').addEventListener('click', () => {
    const t = $('token');
    const show = t.type === 'password';
    t.type = show ? 'text' : 'password';
    $('toggleToken').textContent = show ? '隐藏' : '显示';
  });

  $('testBtn').addEventListener('click', async () => {
    const st = $('status');
    const form = readForm();
    if (!form.token) return setStatus(st, '先填访问令牌', 'err');
    if (!form.owner) return setStatus(st, '仓库地址格式不对，应形如 github.com/用户名/时光', 'err');
    setStatus(st, '连接中…');
    $('testBtn').disabled = true;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', settings: form });
      if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
      const priv = r.private ? '私有' : '公开';
      setStatus(st, `已连上 ${r.repo}（${priv}，默认分支 ${r.defaultBranch}）${r.canPush === false ? ' · 警告：令牌可能没有写权限' : ''}`, 'ok');
    } catch (e) {
      setStatus(st, e.message, 'err');
    } finally {
      $('testBtn').disabled = false;
    }
  });

  $('saveBtn').addEventListener('click', async () => {
    const form = readForm();
    const st = $('saveStatus');
    if (!form.owner) return setStatus(st, '仓库地址格式不对', 'err');
    await saveSettings(form);
    setStatus(st, '已保存', 'ok');
    setTimeout(() => setStatus(st, ''), 2500);
  });

  // 回车即保存
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') $('saveBtn').click();
  });
}

init();
