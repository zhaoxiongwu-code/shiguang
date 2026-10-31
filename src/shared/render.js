// 渲染层：把抽取结果（纯数据）渲染成 Markdown / HTML。
// 图片在抽取阶段是 {{IMG:n}} 占位符，下载完成后在这里替换成仓库内相对路径；
// 下载失败的图片退回原始外链，保证内容不丢。

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function encodePath(p) {
  // 中文目录名在 GitHub 的相对链接里没问题，但要转义空格和 # ? 等
  return String(p).split('/').map(function (seg) {
    return encodeURIComponent(seg).replace(/%3A/g, ':');
  }).join('/');
}

function imgSrc(im, imageBase) {
  if (!im) return '';
  if (im.ok && im.path) {
    // im.path 是相对仓库根的路径；页面内引用只需相对本文件
    return imageBase ? imageBase + '/' + im.path.split('/').pop() : im.path;
  }
  return im.src;
}

function altText(s) {
  return String(s || '').replace(/[\[\]\n\r]/g, ' ').trim();
}

export function renderMarkdown(model, meta) {
  const images = model.images || [];
  const lines = [];
  lines.push('# ' + String(meta.title || '').replace(/\n/g, ' '));
  lines.push('');
  lines.push('- 来源：<' + meta.url + '>');
  lines.push('- 收藏时间：' + meta.savedAt);
  if (meta.author) lines.push('- 作者：' + meta.author);
  if (meta.tags && meta.tags.length) lines.push('- 标签：' + meta.tags.map(function (t) { return '`' + t + '`'; }).join(' '));
  if (meta.htmlPath) lines.push('- 网页存档：[' + meta.htmlPath + '](' + meta.htmlPath + ')');
  if (meta.imageFailures && meta.imageFailures.length) {
    lines.push('- 说明：' + meta.imageFailures.length + ' 张图片未能下载，已保留原始链接');
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (let i = 0; i < (model.blocks || []).length; i++) {
    const md = String(model.blocks[i].md).replace(/\{\{IMG:(\d+)\}\}/g, function (_, n) {
      const im = images[Number(n)];
      if (!im) return '';
      return '![' + altText(im.alt) + '](' + encodePath(imgSrc(im, meta.imageBase)) + ')';
    }).trim();
    if (!md) continue;
    lines.push(md);
    lines.push('');
  }

  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/\n+$/, '\n') + '\n';
}

export function renderHtml(model, meta) {
  const images = model.images || [];
  const body = (model.blocks || []).map(function (b) {
    return String(b.html).replace(/\{\{IMG:(\d+)\}\}/g, function (_, n) {
      const im = images[Number(n)];
      if (!im) return '';
      return '<p class="sg-img"><img src="' + escHtml(imgSrc(im, meta.imageBase)) + '" alt="' + escHtml(im.alt || '') + '"></p>';
    });
  }).join('\n');

  return '<!DOCTYPE html>\n' +
    '<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="generator" content="时光 · 网页收藏">\n' +
    '<title>' + escHtml(meta.title) + '</title>\n' +
    '<style>\n' +
    ':root{color-scheme:light dark}\n' +
    'body{max-width:46rem;margin:0 auto;padding:2rem 1.25rem 4rem;font:16px/1.78 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#fbf8f4;color:#2b2523}\n' +
    '@media(prefers-color-scheme:dark){body{background:#1a1614;color:#e8e0d8}}\n' +
    'header{border-bottom:1px solid rgba(128,128,128,.3);padding-bottom:1rem;margin-bottom:2rem}\n' +
    'header h1{font-size:1.7rem;line-height:1.35;margin:0 0 .75rem}\n' +
    'header .sub{font-size:.875rem;opacity:.75;word-break:break-all}\n' +
    'header a{color:#c96a2b}\n' +
    'h2,h3,h4{line-height:1.4;margin:2rem 0 .75rem}\n' +
    'p{margin:0 0 1rem}\n' +
    'img{max-width:100%;height:auto;border-radius:6px;display:block;margin:1.25rem 0}\n' +
    'blockquote{margin:1rem 0;padding:.25rem 1rem;border-left:3px solid #e8833a;opacity:.9}\n' +
    'pre{background:rgba(128,128,128,.12);padding:1rem;border-radius:8px;overflow:auto}\n' +
    'code{font-family:ui-monospace,Consolas,monospace;font-size:.9em}\n' +
    'table{border-collapse:collapse;width:100%;margin:1rem 0}\n' +
    'td,th{border:1px solid rgba(128,128,128,.35);padding:.4rem .6rem}\n' +
    'figcaption{font-size:.875rem;opacity:.7;text-align:center}\n' +
    '</style>\n</head>\n<body>\n<header>\n' +
    '  <h1>' + escHtml(meta.title) + '</h1>\n' +
    '  <div class="sub">来源：<a href="' + escHtml(meta.url) + '" target="_blank" rel="noreferrer">' + escHtml(meta.url) + '</a><br>收藏时间：' + escHtml(meta.savedAt) + '</div>\n' +
    '</header>\n<main>\n' + body + '\n</main>\n</body>\n</html>\n';
}

