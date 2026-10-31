// 注入网页执行的抽取函数。
//
// MV3 的 executeScript 只序列化这一个函数，函数体内引用的外部标识符不会一起带过去，
// 所以这里必须完全自包含。同时它刻意只使用一个干净的 DOM 根节点，
// 读取真实渲染后的属性（懒加载图片已由页面脚本写回 src 的话就能拿到）。
//
// 返回值通过 postMessage 序列化回扩展，所以只返回纯数据。

export function pageExtractor() {
  const SKIP = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, CANVAS: 1,
    VIDEO: 1, AUDIO: 1, FORM: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1,
    BUTTON: 1, TEMPLATE: 1, LINK: 1, META: 1, NAV: 1, HEADER: 1, FOOTER: 1,
    ASIDE: 1, DIALOG: 1, MENU: 1, SVG: 1,
  };
  const BLOCK = {
    P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    UL: 1, OL: 1, LI: 1, BLOCKQUOTE: 1, PRE: 1, TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1,
    TR: 1, TD: 1, TH: 1, FIGCAPTION: 1, FIGURE: 1, HR: 1, DL: 1, DT: 1, DD: 1, BODY: 1, HTML: 1,
  };
  const CONTAINER = {
    BODY: 1, HTML: 1, MAIN: 1, ARTICLE: 1, SECTION: 1, DIV: 1, FIGURE: 1,
    DETAILS: 1, SUMMARY: 1, FIELDSET: 1,
  };

  const pageUrl = location.href;
  const blocks = [];
  const images = [];
  const imageIndex = Object.create(null);
  const seen = Object.create(null);

  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ');
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escMd(s) {
    return String(s).replace(/([\\`*_[\]])/g, '\\$1');
  }
  function escCell(s) {
    return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  }
  function pad3(n) {
    return String(n).padStart(3, '0');
  }
  function srcsetFirst(el) {
    const ss = el.getAttribute('srcset') || el.getAttribute('data-srcset') || '';
    if (!ss) return '';
    const parts = ss.split(',').map(function (s) { return s.trim().split(/\s+/)[0]; }).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }
  function absUrl(href) {
    if (!href) return null;
    const h = String(href).trim();
    if (!h || h.charAt(0) === '#' || /^(javascript|data|blob|mailto|tel):/i.test(h)) return null;
    try {
      const u = new URL(h, pageUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.href;
    } catch (e) {
      return null;
    }
  }
  function imgName(abs, idx) {
    let ext = '.jpg';
    try {
      const m = new URL(abs).pathname.match(/\.(png|jpe?g|gif|webp|avif|svg|bmp)(?:$|\?)/i);
      if (m) ext = '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
    } catch (e) { /* ignore */ }
    return pad3(idx + 1) + ext;
  }
  function registerImage(el) {
    let raw = el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data-original')
      || el.getAttribute('data-lazy-src') || el.getAttribute('data-actualsrc') || '';
    if (!raw) raw = srcsetFirst(el);
    const abs = absUrl(raw);
    if (!abs) return null;
    if (abs in imageIndex) return imageIndex[abs];
    const idx = images.length;
    images.push({ index: idx, src: abs, alt: norm(el.getAttribute('alt') || '').trim(), fileName: imgName(abs, idx), ok: false, path: '' });
    imageIndex[abs] = idx;
    return idx;
  }
  function isHidden(el) {
    if (el.hasAttribute('hidden')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const st = el.getAttribute('style') || '';
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(st)) return true;
    // 「编辑」「[编辑]」这类章节工具条、跳到导航之类的链接，没有信息量
    const cls = (el.getAttribute('class') || '') + ' ' + (el.getAttribute('id') || '');
    if (/\b(mw-editsection|navbox|nav(igation)?|sidebar|toc|breadcrumb|cookie|share|social|advert)\b/i.test(cls)) return true;
    return false;
  }
  function imgMd(idx) {
    return '{{IMG:' + idx + '}}';
  }
  // 图片地址统一留成占位符，渲染时再决定用仓库内路径还是原始外链
  function imgHtml(idx) {
    return '{{IMG:' + idx + '}}';
  }
  function findImg(el) {
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType !== 1) continue;
      if (c.tagName === 'IMG') return c;
      const d = findImg(c);
      if (d) return d;
    }
    return null;
  }

  function inline(node) {
    let html = '';
    let md = '';
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === 3) {
        const t = norm(c.nodeValue);
        if (!t.trim()) { if (t) { html += ' '; md += ' '; } continue; }
        html += escHtml(t);
        md += escMd(t);
        continue;
      }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName;
      if (tag === 'BR') { html += '<br>'; md += '\n'; continue; }
      if (tag === 'IMG') {
        const idx = registerImage(c);
        if (idx === null) continue;
        html += imgHtml(idx) + '\n';
        md += '\n\n' + imgMd(idx) + '\n\n';
        continue;
      }
      if (tag === 'PICTURE') {
        const im = findImg(c);
        if (!im) continue;
        const idx = registerImage(im);
        if (idx === null) continue;
        html += imgHtml(idx) + '\n';
        md += '\n\n' + imgMd(idx) + '\n\n';
        continue;
      }
      if (tag === 'A') {
        const sub = inline(c);
        const href = absUrl(c.getAttribute('href'));
        const text = sub.md.trim();
        if (!href || !text) { html += sub.html; md += sub.md; continue; }
        html += '<a href="' + escHtml(href) + '">' + sub.html + '</a>';
        md += '[' + text + '](' + href + ')';
        continue;
      }
      if (SKIP[tag]) continue;
      const sub = inline(c);
      if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
        html += '<code>' + sub.html + '</code>';
        const t = sub.md.replace(/`/g, "'").replace(/\n+/g, ' ');
        md += t ? '`' + t + '`' : '';
        continue;
      }
      if (tag === 'STRONG' || tag === 'B') { html += '<strong>' + sub.html + '</strong>'; const t = sub.md.trim(); md += t ? '**' + t + '**' : ''; continue; }
      if (tag === 'EM' || tag === 'I' || tag === 'CITE') { html += '<em>' + sub.html + '</em>'; const t = sub.md.trim(); md += t ? '*' + t + '*' : ''; continue; }
      if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') { html += '<del>' + sub.html + '</del>'; const t = sub.md.trim(); md += t ? '~~' + t + '~~' : ''; continue; }
      if (tag === 'SUP' || tag === 'SUB') { const l = tag.toLowerCase(); html += '<' + l + '>' + sub.html + '</' + l + '>'; md += sub.md; continue; }
      html += sub.html;
      md += sub.md;
    }
    return { html: html, md: md };
  }

  function push(tag, html, md) {
    const key = md.replace(/\s+/g, ' ').trim();
    if (!key) return;
    if (seen[key]) return;
    seen[key] = 1;
    blocks.push({ tag: tag, html: html, md: md });
  }

  function hasBlockChild(el) {
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType !== 1) continue;
      if (BLOCK[c.tagName] || CONTAINER[c.tagName]) return true;
    }
    return false;
  }

  function descend(el) {
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) block(kids[i]);
  }

  function collectTrs(el, out) {
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType !== 1) continue;
      if (c.tagName === 'TR') out.push(c);
      else collectTrs(c, out);
    }
    return out;
  }

  // 单元格取文字时跳过 <style>/<script> 之类的噪音节点
  function cellText(node) {
    let s = '';
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === 3) { s += c.nodeValue; continue; }
      if (c.nodeType !== 1) continue;
      if (SKIP[c.tagName]) continue;
      s += cellText(c);
    }
    return norm(s).trim();
  }

  function blockQuoteMd(el, out) {
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === 3) {
        const t = norm(c.nodeValue).trim();
        if (t) out.push(t);
        continue;
      }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName;
      if (SKIP[tag]) continue;
      if (BLOCK[tag]) {
        const sub = inline(c);
        const t = norm(sub.md).trim();
        if (t) out.push(t);
      } else {
        blockQuoteMd(c, out);
      }
    }
  }

  function block(el) {
    if (el.nodeType === 3) {
      const t = norm(el.nodeValue).trim();
      if (t) push('p', '<p>' + escHtml(t) + '</p>', escMd(t));
      return;
    }
    if (el.nodeType !== 1) return;
    const tag = el.tagName;
    if (SKIP[tag] || isHidden(el)) return;

    if (tag === 'IMG') {
      const idx = registerImage(el);
      if (idx !== null) push('img', imgHtml(idx), imgMd(idx));
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      const lv = Number(tag.charAt(1));
      const sub = inline(el);
      const text = norm(sub.md).trim();
      if (!text) return;
      const t = tag.toLowerCase();
      push('h' + lv, '<' + t + '>' + sub.html + '</' + t + '>', new Array(lv + 1).join('#') + ' ' + text);
      return;
    }
    if (tag === 'P') {
      const sub = inline(el);
      const md = norm(sub.md).trim();
      if (!md) return;
      if (/^\{\{IMG:\d+\}\}$/.test(md)) {
        const idx = Number(md.replace(/\D/g, ''));
        push('img', imgHtml(idx), md);
      } else {
        push('p', '<p>' + sub.html + '</p>', md);
      }
      return;
    }
    if (tag === 'PRE') {
      const code = (el.textContent || '').replace(/^\n+|\n+$/g, '');
      if (!code.trim()) return;
      push('pre', '<pre><code>' + escHtml(code) + '</code></pre>', '```\n' + code + '\n```');
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      const parts = [];
      blockQuoteMd(el, parts);
      const text = parts.join('\n\n').trim();
      if (!text) return;
      const quoted = text.split('\n').map(function (l) { return l ? '> ' + l : '>'; }).join('\n');
      push('quote', '<blockquote>' + escHtml(text).replace(/\n/g, '<br>') + '</blockquote>', quoted);
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      const ordered = tag === 'OL';
      const items = [];
      const htmls = [];
      const kids = el.childNodes;
      let n = 0;
      for (let i = 0; i < kids.length; i++) {
        const li = kids[i];
        if (li.nodeType !== 1 || li.tagName !== 'LI') continue;
        n++;
        const sub = inline(li);
        const text = norm(sub.md).replace(/\{\{IMG:\d+\}\}/g, '').trim();
        if (!text) continue;
        items.push((ordered ? n + '. ' : '- ') + text);
        htmls.push('<li>' + sub.html + '</li>');
      }
      if (!items.length) return;
      const t = tag.toLowerCase();
      push('list', '<' + t + '>' + htmls.join('') + '</' + t + '>', items.join('\n'));
      return;
    }
    if (tag === 'TABLE') {
      const trs = collectTrs(el, []);
      const rows = [];
      for (let i = 0; i < trs.length; i++) {
        const cells = [];
        const cs = trs[i].childNodes;
        for (let j = 0; j < cs.length; j++) {
          const c = cs[j];
          if (c.nodeType !== 1) continue;
          if (c.tagName !== 'TD' && c.tagName !== 'TH') continue;
          cells.push(cellText(c));
        }
        if (cells.length) rows.push(cells);
      }
      if (!rows.length) return;
      // 一列都没有、或者全表只有一个词（常见于「导航框」）就不当表格处理
      if (rows.length < 2 && rows[0].filter(Boolean).length < 2) return;
      let width = 0;
      for (let i = 0; i < rows.length; i++) width = Math.max(width, rows[i].length);
      function padRow(r) { const c = r.slice(); while (c.length < width) c.push(''); return c; }
      const lines = [];
      lines.push('| ' + padRow(rows[0]).map(escCell).join(' | ') + ' |');
      const sep = [];
      for (let i = 0; i < width; i++) sep.push('---');
      lines.push('| ' + sep.join(' | ') + ' |');
      for (let i = 1; i < rows.length; i++) lines.push('| ' + padRow(rows[i]).map(escCell).join(' | ') + ' |');
      const tHtml = '<table>' + rows.map(function (r) {
        return '<tr>' + r.map(function (c) { return '<td>' + escHtml(c) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</table>';
      push('table', tHtml, lines.join('\n'));
      return;
    }
    if (tag === 'HR') { push('hr', '<hr>', '---'); return; }
    if (tag === 'FIGURE') { descend(el); return; }
    if (tag === 'FIGCAPTURE') {
      const sub = inline(el);
      const t = norm(sub.md).trim();
      if (t) push('caption', '<figcaption>' + sub.html + '</figcaption>', '*' + t + '*');
      return;
    }
    if (tag === 'DT') {
      const sub = inline(el);
      const t = norm(sub.md).trim();
      if (t) push('dt', '<dt>' + sub.html + '</dt>', '**' + t + '**');
      return;
    }
    if (tag === 'DD') {
      const sub = inline(el);
      const t = norm(sub.md).trim();
      if (t) push('dd', '<dd>' + sub.html + '</dd>', t);
      return;
    }
    if (CONTAINER[tag]) { descend(el); return; }
    if (!hasBlockChild(el)) {
      const sub = inline(el);
      const t = norm(sub.md).trim();
      if (t) push('p', '<p>' + sub.html + '</p>', t);
      return;
    }
    descend(el);
  }

  // 选正文容器：article/main 优先，但要求它覆盖了 body 的大部分内容
  function pickRoot() {
    const body = document.body || document.documentElement;
    const bodyLen = norm(body.textContent || '').length;
    const cands = ['article', 'main', '[role="main"]', '#content', '.content', '.post', '.article', '.markdown-body'];
    for (let i = 0; i < cands.length; i++) {
      let el = null;
      try { el = document.querySelector(cands[i]); } catch (e) { el = null; }
      if (!el) continue;
      const len = norm(el.textContent || '').length;
      if (len > 200 && len >= bodyLen * 0.4) return el;
    }
    // 兜底：剔除噪音后从 body 开始
    const junk = body.querySelectorAll('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .sidebar, .comments, #comments');
    for (let i = junk.length - 1; i >= 0; i--) {
      const p = junk[i].parentNode;
      if (p) p.removeChild(junk[i]);
    }
    return body;
  }

  let root;
  try {
    root = pickRoot();
  } catch (e) {
    root = document.body || document.documentElement;
  }
  descend(root);

  const ogEl = document.querySelector('meta[property="og:title"]');
  const ogTitle = ogEl ? ogEl.getAttribute('content') || '' : '';
  const h1El = document.querySelector('h1');
  const h1Title = h1El ? norm(h1El.textContent).trim() : '';
  // 优先正文里的一级标题：og:title 常常带上「- 站点名」后缀
  let title = h1Title || norm(ogTitle).trim() || norm(document.title).trim() || location.hostname;
  const docTitle = norm(document.title).trim();
  if (!h1Title && docTitle && title.endsWith(' - ' + docTitle)) title = docTitle;

  return {
    title: title,
    url: pageUrl,
    blocks: blocks,
    images: images,
    stats: { blocks: blocks.length, images: images.length, chars: blocks.reduce(function (s, b) { return s + b.md.length; }, 0) },
  };
}


