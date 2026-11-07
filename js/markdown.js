// Minimal, safe Markdown renderer. Everything is HTML-escaped first; only
// whitelisted constructs become markup. Only http(s) links are rendered.

export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unescapeHtml(s) {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

// exists(title) → boolean, used to style unresolved links.
export function renderMarkdown(src, exists = () => true) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let para = [];
  let list = null;

  const flushPara = () => {
    if (para.length) html += `<p>${inline(para.join(' '))}</p>`;
    para = [];
  };
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  const openList = (type) => {
    if (list !== type) {
      closeList();
      html += `<${type}>`;
      list = type;
    }
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    let m;
    if (/^```/.test(line)) {
      flushPara();
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += `<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`;
      continue;
    }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flushPara();
      closeList();
      const level = m[1].length;
      html += `<h${level}>${inline(m[2])}</h${level}>`;
      i++;
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara();
      closeList();
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      closeList();
      html += '<hr>';
      i++;
      continue;
    }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      flushPara();
      openList('ul');
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(m[1]);
      html += task
        ? `<li class="task"><input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ${inline(task[2])}</li>`
        : `<li>${inline(m[1])}</li>`;
      i++;
      continue;
    }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara();
      openList('ol');
      html += `<li>${inline(m[1])}</li>`;
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      closeList();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${inline(buf.join(' '))}</blockquote>`;
      continue;
    }
    closeList();
    para.push(line.trim());
    i++;
  }
  flushPara();
  closeList();
  return html;

  function inline(text) {
    const codes = [];
    text = text.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    let s = escapeHtml(text);
    s = s.replace(/\[\[([^[\]|#\n]+)(#[^[\]|\n]*)?(?:\|([^[\]\n]*))?\]\]/g, (_, t, _h, alias) => {
      const title = t.trim();
      const cls = exists(unescapeHtml(title)) ? 'wikilink' : 'wikilink unresolved';
      return `<a href="#" class="${cls}" data-target="${title}">${alias ? alias.trim() : title}</a>`;
    });
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    s = s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${escapeHtml(codes[Number(n)])}</code>`);
    return s;
  }
}
