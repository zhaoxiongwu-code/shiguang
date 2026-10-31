// 单次收藏的完整流水线：下载图片 → 渲染 Markdown/HTML → 一次提交到仓库。
// 不依赖 chrome.*，也不依赖 Node 专有 API（Buffer / DOMParser 都没有），
// 这样 service worker 和测试可以跑同一份代码。

import { renderMarkdown, renderHtml } from './render.js';
import { commitFiles } from './github.js';

export function slugify(title, maxLen = 48) {
  const cleaned = String(title || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#%&{}\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.\s]+|[-.\s]+$/g, '');
  const arr = Array.from(cleaned);
  const cut = (arr.length > maxLen ? arr.slice(0, maxLen).join('') : cleaned).replace(/[-.\s]+$/g, '');
  return cut || 'untitled';
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function formatDateTime(d = new Date()) {
  return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function buildFolderName(title, now = new Date()) {
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `${formatDate(now)}-${slugify(title)}-${time}`;
}

export function buildPaths(folder) {
  return {
    folder,
    markdown: `${folder}/index.md`,
    html: `${folder}/index.html`,
    imageDir: `${folder}/assets`,
  };
}

// ---- 图片 ----

export function bytesToBase64(bytes) {
  // 扩展环境有 btoa；Node 的 btoa 对超大输入会爆栈风险的唯一出路是分块，这里同样分块
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return globalThis.btoa ? globalThis.btoa(bin) : Buffer.from(bytes).toString('base64');
}

export function extFromMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
  }[m] || '';
}

/** 服务器返回的真实类型优先于文件名后缀 */
export function reconcileName(fileName, mime, ok) {
  if (!ok) return fileName;
  const real = extFromMime(mime);
  if (!real) return fileName;
  const cur = (fileName.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (cur === real) return fileName;
  return fileName.replace(/\.[^.]+$/, '') + real;
}

export function sniffMime(bytes) {
  if (!bytes || bytes.length < 12) return '';
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  const head = String.fromCharCode.apply(null, Array.from(b.subarray(0, 64)));
  if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return '';
}

/**
 * 下载单张图片。先带 Referer（多数站点防盗链需要），失败再不带。
 * @returns {{base64:string, mime:string, size:number} | {error:string}}
 */
export async function fetchImage(src, pageUrl, { fetchImpl = globalThis.fetch, timeout = 20000 } = {}) {
  const attempts = [{ referer: pageUrl }, {}];
  let lastErr = '未知错误';
  for (const opt of attempts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetchImpl(src, {
        signal: ctrl.signal,
        redirect: 'follow',
        credentials: 'omit',
        cache: 'force-cache',
        headers: {
          ...(opt.referer ? { Referer: opt.referer } : {}),
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.length) { lastErr = '空文件'; continue; }
      const headerType = res.headers.get('content-type') || '';
      if (headerType && !/^image\//i.test(headerType) && !/octet-stream/i.test(headerType)) {
        lastErr = `不是图片（${headerType.split(';')[0]}）`;
        continue;
      }
      const sniffed = sniffMime(buf);
      if (!sniffed && !/^image\//i.test(headerType)) { lastErr = '无法识别的图片格式'; continue; }
      return { base64: bytesToBase64(buf), mime: sniffed || headerType, size: buf.byteLength };
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? '下载超时' : (e && e.message) || String(e);
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: lastErr };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 主流程。
 * @param {object} p
 * @param {{title:string,url:string,blocks:any[],images:any[]}} p.model 由 extractDocument 产出
 * @param {object} p.client   makeClient 的返回值
 * @param {object} p.config   { rootFolder, branch, tags, saveImages, saveHtml }
 */
export async function saveSnapshot({ model, client, config, fetchImpl = globalThis.fetch, now = new Date(), onProgress }) {
  const title = (model.title || '').trim() || model.url;
  const root = (config.rootFolder || '').replace(/^\/+|\/+$/g, '');
  const folderBase = buildFolderName(title, now);
  const folder = root ? `${root}/${folderBase}` : folderBase;
  const paths = buildPaths(folder);

  const images = (model.images || []).map((im) => ({ ...im }));
  const files = [];
  const notify = typeof onProgress === 'function' ? onProgress : () => {};

  // 1) 下载图片（并发 4）。关闭「保存图片」时也要逐张标记为失败，渲染层才会退回外链
  const failures = [];
  if (config.saveImages === false) {
    for (const img of images) {
      img.ok = false;
      img.path = '';
    }
  } else if (images.length) {
    if (notify) await notify(0, images.length, 'images');
    let done = 0;
    const results = await mapLimit(images, 4, async (img) => {
      const r = await fetchImage(img.src, model.url, { fetchImpl });
      done++;
      if (notify) await notify(done, images.length, 'images');
      return { img, r };
    });
    for (const { img, r } of results) {
      if (!r || r.error) {
        failures.push({ src: img.src, error: (r && r.error) || '未知错误' });
        img.ok = false;
        continue;
      }
      const name = reconcileName(img.fileName, r.mime, true);
      const remotePath = `${paths.imageDir}/${name}`;
      files.push({ path: remotePath, content: { base64: r.base64 } });
      img.ok = true;
      img.path = remotePath;
      img.bytes = r.size;
    }
  }

  const liveModel = { ...model, images };

  // 2) Markdown。Git 只记录相对仓库根的路径，所以正文里的图片链接要回退到文章所在层级
  const md = renderMarkdown(liveModel, {
    title,
    url: model.url,
    savedAt: formatDateTime(now),
    tags: config.tags || [],
    htmlPath: config.saveHtml !== false ? 'index.html' : null,
    imageFailures: failures,
    imageBase: 'assets',
  });
  files.push({ path: paths.markdown, content: md });

  // 3) HTML
  if (config.saveHtml !== false) {
    files.push({
      path: paths.html,
      content: renderHtml(liveModel, { title, url: model.url, savedAt: formatDateTime(now), imageBase: 'assets' }),
    });
  }

  // 4) 一次提交
  if (notify) await notify(images.length, images.length, 'upload');
  const commit = await commitFiles(client, {
    branch: config.branch || 'main',
    message: `📥 收藏：${title}`,
    files,
  });

  return {
    folder,
    markdownPath: paths.markdown,
    htmlPath: config.saveHtml !== false ? paths.html : null,
    imageTotal: images.length,
    imageSaved: images.filter((i) => i.ok).length,
    imageFailures: failures,
    commitSha: commit.commitSha,
    branch: commit.branch,
    fileCount: files.length,
    bytes: images.reduce((s, i) => s + (i.bytes || 0), 0),
  };
}
