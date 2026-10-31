// Service worker：编排「抓取 → 下载 → 提交」，并把进度广播给弹窗。
//
// 之所以放在 background 而不是 popup 里做：popup 一失焦就会被销毁，
// 而下载图片 + 多次 GitHub 请求可能要好几十秒。

import { makeClient } from './shared/github.js';
import { saveSnapshot } from './shared/save.js';
import { pageExtractor } from './shared/page-extractor.js';
import { DEFAULT_SETTINGS, loadSettings } from './shared/settings.js';

const jobs = new Map(); // jobId -> { state, step, ... }

// 官方 github.com 的仓库页 / 文件页不采集，直接走 raw 链接
chrome.runtime.onInstalled.addListener(async () => {
  const s = await loadSettings();
  if (!s.token) {
    // 首次安装时把选项页打开，省得用户找不到入口
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'START_SAVE') {
    startSave(msg.tabId, msg.options || {}).catch((e) => {
      console.error('[时光] 保存失败', e);
    });
    sendResponse({ ok: true, jobId: 'single' });
    return false;
  }
  if (msg && msg.type === 'GET_JOB') {
    sendResponse({ job: jobs.get(msg.jobId || 'single') || null });
    return false;
  }
  if (msg && msg.type === 'TEST_CONNECTION') {
    testConnection(msg.settings).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

async function broadcast(job) {
  try {
    await chrome.runtime.sendMessage({ type: 'JOB_UPDATE', job });
  } catch {
    // 弹窗已关闭时会报错，正常
  }
  // 顺带同步一份到 badge
  const text = job.state === 'running' ? (job.stepType === 'upload' ? '↑' : '…')
    : job.state === 'done' ? '✓' : job.state === 'error' ? '!' : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: job.state === 'error' ? '#c0392b' : '#e8833a' });
}

async function startSave(tabId, options) {
  const settings = await loadSettings();
  const job = {
    id: 'single',
    state: 'running',
    step: '准备中…',
    stepType: 'fetch',
    startedAt: Date.now(),
    tabId,
    owner: settings.owner,
    repo: settings.repo,
  };
  jobs.set('single', job);
  const update = async (patch) => {
    Object.assign(job, patch);
    await broadcast({ ...job });
  };
  await update({});

  try {
    if (!settings.token || !settings.owner || !settings.repo) {
      throw new Error('还没配置 GitHub：点击扩展图标后选「设置」，填入令牌与仓库。');
    }

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('找不到当前标签页');
    if (/^chrome:|^edge:|^about:|^chrome-extension:|^edge-extension:/i.test(tab.url || '')) {
      throw new Error('浏览器内置页面无法读取，请切换到普通网页后重试。');
    }

    await update({ step: '读取网页内容…', stepType: 'fetch', pageTitle: tab.title, pageUrl: tab.url });

    let injected;
    try {
      injected = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: pageExtractor,
      });
    } catch (e) {
      throw new Error(`无法读取页面（${e.message}）。浏览器商店页、PDF 阅读器和部分特权页面不允许注入脚本。`);
    }
    const model = injected && injected[0] && injected[0].result;
    if (!model || !model.blocks || !model.blocks.length) {
      throw new Error('这个页面没有抽到正文，可能在框架内或需要滚动加载后再试。');
    }

    // 用户在弹窗里改过的选项优先
    const config = {
      ...settings,
      tags: options.tags !== undefined ? options.tags : settings.defaultTags,
      saveImages: options.saveImages !== undefined ? options.saveImages : settings.saveImages,
      saveHtml: options.saveHtml !== undefined ? options.saveHtml : settings.saveHtml,
      rootFolder: (settings.rootFolder || '').trim(),
    };

    await update({
      step: `下载图片 0/${model.images.length}…`,
      stepType: 'images',
      pageTitle: model.title || tab.title,
      stats: model.stats,
    });

    const client = makeClient({
      token: settings.token,
      owner: settings.owner,
      repo: settings.repo,
      branch: settings.branch || 'main',
    });

    let lastProgress = 0;
    const result = await saveSnapshot({
      model,
      client,
      config,
      onProgress: async (done, total, phase) => {
        const now = Date.now();
        if (now - lastProgress < 120 && done !== total) return;
        lastProgress = now;
        if (phase === 'images') {
          await update({ step: `下载图片 ${done}/${total}…`, stepType: 'images' });
        } else {
          await update({ step: '上传到 GitHub…', stepType: 'upload' });
        }
      },
    });

    await update({
      state: 'done',
      step: '已保存',
      stepType: 'done',
      result,
      finishedAt: Date.now(),
    });

    // 留着 badge 一会儿，然后清掉
    setTimeout(() => {
      if (jobs.get('single') && jobs.get('single').state === 'done') {
        chrome.action.setBadgeText({ text: '' });
      }
    }, 8000);
  } catch (e) {
    await update({
      state: 'error',
      step: '保存失败',
      error: (e && e.message) || String(e),
      finishedAt: Date.now(),
    });
  }
}

async function testConnection(settings) {
  if (!settings || !settings.token) return { ok: false, error: '请先填写访问令牌' };
  const client = makeClient({
    token: settings.token,
    owner: settings.owner,
    repo: settings.repo,
    branch: settings.branch || DEFAULT_SETTINGS.branch,
  });
  const info = await client.getRepo();
  const perms = (info.permissions) || {};
  return {
    ok: true,
    repo: info.full_name,
    private: info.private,
    defaultBranch: info.default_branch,
    canPush: perms.push !== false,
    url: info.html_url,
  };
}
