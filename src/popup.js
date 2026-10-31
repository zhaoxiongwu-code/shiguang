import { loadSettings, saveSettings, parseTags } from './shared/settings.js';

const $ = (id) => document.getElementById(id);
let currentTab = null;
let started = false;

function setStatus(text, kind) {
  $('status').textContent = text || '';
  $('status').className = 'status' + (kind ? ' ' + kind : '');
}

function busy(on) {
  $('saveBtn').disabled = on;
  $('saveBtn').textContent = on ? '保存中…' : '保存到 GitHub';
  $('progress').classList.toggle('on', on);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  const settings = await loadSettings();

  if (!settings.token || !settings.owner || !settings.repo) {
    $('mainView').style.display = 'none';
    $('setupView').classList.add('on');
  }

  if (tab) {
    $('pageTitle').textContent = tab.title || '（无标题）';
    $('pageUrl').textContent = tab.url || '';
  }
  $('tags').value = (settings.defaultTags || []).join(', ');
  $('optImages').checked = settings.saveImages !== false;
  $('optHtml').checked = settings.saveHtml !== false;

  // 如果后台已经在跑（关掉再开弹窗），接着显示进度
  const { job } = await chrome.runtime.sendMessage({ type: 'GET_JOB', jobId: 'single' }).catch(() => ({ job: null }));
  if (job) renderJob(job);

  $('saveBtn').addEventListener('click', startSave);
  $('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

async function startSave() {
  if (!currentTab || !currentTab.id) return setStatus('拿不到当前标签页', 'err');
  started = true;
  busy(true);
  $('result').classList.remove('on');
  setStatus('准备中…');

  const tags = parseTags($('tags').value);
  const saveImages = $('optImages').checked;
  const saveHtml = $('optHtml').checked;

  // 记住这次的选择
  await saveSettings({ defaultTags: tags, saveImages, saveHtml }).catch(() => {});

  try {
    await chrome.runtime.sendMessage({
      type: 'START_SAVE',
      tabId: currentTab.id,
      options: { tags, saveImages, saveHtml },
    });
  } catch (e) {
    setStatus('无法启动保存：' + e.message, 'err');
    busy(false);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'JOB_UPDATE' && msg.job && msg.job.tabId === (currentTab && currentTab.id)) {
    started = true;
    renderJob(msg.job);
  }
});

function renderJob(job) {
  if (job.pageTitle) $('pageTitle').textContent = job.pageTitle;
  if (job.state === 'running') {
    busy(true);
    setStatus(job.step || '处理中…');
    return;
  }
  busy(false);
  if (job.state === 'error') {
    setStatus(job.error || '保存失败', 'err');
    return;
  }
  if (job.state === 'done' && job.result) {
    const r = job.result;
    setStatus('已保存到 GitHub', 'ok');
    $('result').classList.add('on');
    $('rFolder').textContent = r.folder;
    $('rImages').textContent = `${r.imageSaved}/${r.imageTotal}`;
    $('rCommit').textContent = (r.commitSha || '').slice(0, 7);
    $('rWarn').textContent = r.imageFailures && r.imageFailures.length
      ? `${r.imageFailures.length} 张图片下载失败，已保留原始链接`
      : '';
    const link = job.owner && job.repo
      ? `https://github.com/${job.owner}/${job.repo}/blob/${r.branch}/` + encodeURI(r.markdownPath)
      : '';
    if (link) {
      $('rLink').href = link;
      $('rLink').style.display = '';
    } else {
      $('rLink').style.display = 'none';
    }
  }
}

init();

