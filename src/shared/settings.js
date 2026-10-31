// 设置读写。令牌只存在 chrome.storage.local，不同步到云端。

export const DEFAULT_SETTINGS = {
  token: '',
  owner: '',
  repo: '',
  branch: 'main',
  rootFolder: '',
  saveImages: true,
  saveHtml: true,
  defaultTags: [],
};

export const STORAGE_KEY = 'shiguang.settings';

export async function loadSettings() {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[STORAGE_KEY] || {}) };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** 从 https://github.com/owner/repo 里解出 owner / repo */
export function parseRepoUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // 允许直接写 owner/repo
  const bare = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (bare) return { owner: bare[1], repo: bare[2].replace(/\.git$/, '') };
  try {
    const u = new URL(s);
    if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
  } catch {
    return null;
  }
}

/** 标签输入：逗号/空格/中文顿号分隔 */
export function parseTags(input) {
  if (Array.isArray(input)) return input.map((t) => String(t).trim()).filter(Boolean);
  return String(input || '')
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}
