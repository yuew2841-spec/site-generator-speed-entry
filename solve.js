// A faster drop-in for makefun-site 1.0.0: reimplements its exact output semantics
// (front matter, template dialect, Markdown subset, slug rule, report format)
// with single-pass rendering, cached slugs and precompiled templates.
// Written from the README spec and the reference behaviour; no vendor code.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ text */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HAS_SPECIAL = /[&<>"']/;

export function escapeHtml(s) {
  if (!HAS_SPECIAL.test(s)) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    let e;
    if (code === 38) e = '&amp;';
    else if (code === 60) e = '&lt;';
    else if (code === 62) e = '&gt;';
    else if (code === 34) e = '&quot;';
    else if (code === 39) e = '&#39;';
    else continue;
    out += s.slice(last, i) + e;
    last = i + 1;
  }
  return out + s.slice(last);
}

const SLUG_MAX = 64;
const slugCache = new Map();

export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = 0;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

export function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out = slug + '-2';
  while (taken.has(out)) {
    n++;
    out = slug + '-' + n;
  }
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/* ------------------------------------------------------------ front matter */

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += nx;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) {
            ok = false;
            break;
          }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) {
          return { error: 'key "layout": not a template name' };
        }
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // slug must not start with '-'
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
          prevDash = false;
        } else {
          return { error: 'key "slug": not a slug' };
        }
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

export function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  if (nl === -1) return { error: 'the front matter is not closed' };
  // Pass 1: find the closing line before parsing any line inside.
  let closeStart = -1;
  let closeEnd = -1;
  let start = nl + 1;
  while (true) {
    const end = text.indexOf('\n', start);
    const line = end === -1 ? text.slice(start) : text.slice(start, end);
    if (line === '---') {
      closeStart = start;
      closeEnd = end === -1 ? text.length : end + 1;
      break;
    }
    if (end === -1) return { error: 'the front matter is not closed' };
    start = end + 1;
  }
  // Pass 2: parse the lines between the opening and closing lines.
  const data = {};
  let lineNo = 1;
  start = nl + 1;
  while (start < closeStart) {
    const end = text.indexOf('\n', start);
    const line = text.slice(start, end);
    lineNo++;
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        k++;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      let r = raw.length;
      while (r > 0 && (raw.charCodeAt(r - 1) === 32 || raw.charCodeAt(r - 1) === 9)) r--;
      if (r !== raw.length) raw = raw.slice(0, r);
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    start = end + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

/* --------------------------------------------------------------- markdown */

const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) {
  ESCAPABLE[ch.charCodeAt(0)] = 1;
}

function isLangChar(code) {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 43 ||
    code === 45
  );
}

/** Fence-open language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6 || n >= line.length) return null;
  let s = n;
  let spaces = 0;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) {
    s++;
    spaces++;
  }
  if (spaces === 0) return null;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e <= s) return null;
  return { depth: n, text: line.slice(s, e) };
}

function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: line.slice(0, i), text: line.slice(i + 2) };
}

function isSpaceCode(code) {
  return IS_WS[code] === 1;
}

function isContinued(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 32) n++;
  return n >= 2 && n < line.length && !isSpaceCode(line.charCodeAt(n));
}

function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankLine(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** First unescaped ']' from `from`, or -1. */
function findCloseBracket(s, from) {
  let j = s.indexOf(']', from);
  while (j !== -1) {
    let k = j - 1;
    let odd = false;
    while (k >= from && s.charCodeAt(k) === 92) {
      odd = !odd;
      k--;
    }
    if (!odd) return j;
    j = s.indexOf(']', j + 1);
  }
  return -1;
}

/** First unescaped '**' from `from`, or -1. */
function findStrongClose(s, from) {
  let j = s.indexOf('**', from);
  while (j !== -1) {
    let k = j - 1;
    let odd = false;
    while (k >= from && s.charCodeAt(k) === 92) {
      odd = !odd;
      k--;
    }
    if (!odd) return j;
    j = s.indexOf('**', j + 1);
  }
  return -1;
}

/** First single '*' (not beside another '*') from `from`, outside escapes, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let k = j - 1;
    let odd = false;
    while (k >= from && s.charCodeAt(k) === 92) {
      odd = !odd;
      k--;
    }
    if (odd) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** The next `\`, backtick, `*` or `[` at or after `from`, or -1. */
const SPECIAL_RE = /[\\`*[]/g;
function nextSpecial(s, from) {
  SPECIAL_RE.lastIndex = from;
  const m = SPECIAL_RE.exec(s);
  return m === null ? -1 : m.index;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

const HAS_WS = /\s/;

function linkTarget(target, ctx) {
  const c0 = target.charCodeAt(0);
  if (c0 === 47 || c0 === 35) return target;
  if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
    let k = 1;
    for (;;) {
      if (k >= target.length) break;
      const c = target.charCodeAt(k);
      if (c === 58) return target;
      if (
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 43 ||
        c === 45 ||
        c === 46
      ) {
        k++;
        continue;
      }
      break;
    }
  }
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(ctx.dir, rel);
  if (path !== null) {
    const url = ctx.bySource.get(path);
    if (url !== undefined) return url + frag;
    if (ctx.staticPaths.has(path)) return ctx.base + '/' + path + frag;
  }
  ctx.broken.add(`broken-link ${ctx.sourcePath} -> ${target}`);
  return target;
}

const HAS_MD_SPECIAL = /[\\`*[]/;

/** `s` rendered inline; ctx carries the link resolver. */
export function inline(s, ctx) {
  if (!HAS_MD_SPECIAL.test(s)) return escapeHtml(s);
  const out = [];
  const n = s.length;
  let i = 0;
  let last = 0;
  for (;;) {
    const j = nextSpecial(s, i);
    if (j === -1) break;
    const code = s.charCodeAt(j);
    if (code === 92) {
      if (j + 1 < n && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
        if (last < j) out.push(escapeHtml(s.slice(last, j)));
        out.push(escapeHtml(s[j + 1]));
        i = j + 2;
        last = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (code === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (last < j) out.push(escapeHtml(s.slice(last, j)));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        last = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (code === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findStrongClose(s, j + 2);
        if (k > j + 2) {
          if (last < j) out.push(escapeHtml(s.slice(last, j)));
          out.push('<strong>', inline(s.slice(j + 2, k), ctx), '</strong>');
          i = k + 2;
          last = i;
        } else {
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (last < j) out.push(escapeHtml(s.slice(last, j)));
        out.push('<em>', inline(s.slice(j + 1, k), ctx), '</em>');
        i = k + 1;
        last = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    // code === 91 ('[')
    const k = findCloseBracket(s, j + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !HAS_WS.test(target)) {
      if (last < j) out.push(escapeHtml(s.slice(last, j)));
      out.push('<a href="', escapeHtml(linkTarget(target, ctx)), '">', inline(s.slice(j + 1, k), ctx), '</a>');
      i = m + 1;
      last = i;
    } else {
      i = j + 1;
    }
  }
  if (last < n) out.push(escapeHtml(s.slice(last)));
  return out.join('');
}

export function renderMarkdown(src, ctx) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const total = lines.length;
  while (i < total) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
      // A non-blank line opening on a space or tab is paragraph text only.
    } else if (c0 === 96) {
      const fence = fenceOpen(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < total && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        let s = '<pre><code';
        if (fence !== '') s += ' class="language-' + escapeHtml(fence) + '"';
        s += '>';
        if (body.length > 0) s += escapeHtml(body.join('\n')) + '\n';
        s += '</code></pre>';
        out.push(s, '\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, ctx);
        out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>`, '\n');
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>', '\n');
        i++;
        continue;
      }
      const bullet = bulletOf(line);
      if (bullet !== null) {
        const items = [];
        while (i < total) {
          const li = lines[i];
          const m = bulletOf(li);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
          } else if (isContinued(li)) {
            items[items.length - 1].push(trimLine(li));
            i++;
          } else break;
        }
        let s = '<ul>\n';
        for (const parts of items) s += '<li>' + inline(parts.join('\n'), ctx) + '</li>\n';
        s += '</ul>';
        out.push(s, '\n');
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < total && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(trimLine(l));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
      else out.push('<blockquote>\n<p>', inline(kept.join('\n'), ctx), '</p>\n</blockquote>', '\n');
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = orderedOf(line);
      if (ordered !== null) {
        const items = [];
        const start = Number(ordered.num);
        while (i < total) {
          const li = lines[i];
          const o = orderedOf(li);
          if (o !== null) {
            items.push([trimLine(o.text)]);
            i++;
          } else if (isContinued(li)) {
            items[items.length - 1].push(trimLine(li));
            i++;
          } else break;
        }
        let s = start !== 1 ? `<ol start="${start}">` : '<ol>';
        s += '\n';
        for (const parts of items) s += '<li>' + inline(parts.join('\n'), ctx) + '</li>\n';
        s += '</ol>';
        out.push(s, '\n');
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < total && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), ctx);
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>', '\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

/* --------------------------------------------------------------- templates */

export class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Node kinds: 0 text, 1 var/raw, 2 if, 3 for, 4 include, 5 root.
export function parseTemplate(name, src) {
  const root = { k: 5, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ k: 0, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: 1, path: tok.path, raw: tok.t === 'raw' });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 3, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 2, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 2 || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 3 : 2)) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 5 ? parent.body : parent.k === 3 ? parent.body : parent.els ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
        body.push({ k: 4, name: m[1] });
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 3 ? 'for' : 'if'} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const INCLUDE_DEPTH = 8;

/** Whether any non-root scope frame binds one of `names` (a for-loop shadowing). */
function scopeBinds(scope, names) {
  for (let s = scope; s !== null && s.parent !== null; s = s.parent) {
    for (const name of names) if (Object.hasOwn(s.vars, name)) return true;
  }
  return false;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    const k = node.k;
    if (k === 0) {
      out.push(node.text);
    } else if (k === 1) {
      const v = lookup(scope, node.path);
      if (typeof v === 'string') out.push(node.raw ? v : escapeHtml(v));
      else if (v !== undefined && v !== null) {
        const t = textOf(v);
        out.push(node.raw ? t : escapeHtml(t));
      }
    } else if (k === 2) {
      const br = truthy(lookup(scope, node.path)) !== node.not ? node.then : node.els;
      if (br !== null) renderNodes(br, scope, ctx, depth, out);
    } else if (k === 3) {
      const xs = lookup(scope, node.path);
      if (Array.isArray(xs)) {
        const len = xs.length;
        for (let j = 0; j < len; j++) {
          const vars = { [node.name]: xs[j], loop: { index: j + 1, first: j === 0, last: j === len - 1, length: len } };
          renderNodes(node.body, { vars, parent: scope }, ctx, depth, out);
        }
      }
    } else {
      const t = ctx.templates.get(node.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) {
        const info = ctx.info.get(node.name);
        if (info !== undefined && info.cacheable && depth === 0 && !scopeBinds(scope, info.free)) {
          let cached = ctx.cache.get(node.name);
          if (cached === undefined) {
            const tmp = [];
            renderNodes(t, scope, ctx, 1, tmp);
            cached = tmp.join('');
            ctx.cache.set(node.name, cached);
          }
          out.push(cached);
        } else {
          renderNodes(t, scope, ctx, depth + 1, out);
        }
      }
    }
  }
}

/* ------------------------------------------------------------------- build */

const RESERVED = ['posts', 'tags', 'page'];

/** The \s set, as a table over code units (a lone surrogate is never whitespace). */
const IS_WS = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) IS_WS[c] = 1;
for (let c = 8192; c <= 8202; c++) IS_WS[c] = 1;

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (IS_WS[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

const linkOf = (s) =>
  s === null
    ? null
    : {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      };

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  // Per template: the first path segments it can read, transitively through
  // includes. A name bound by the template's own for-loops is not free; a name
  // read only inside such a loop still is. A template reading only
  // site/tags/recent renders the same for every page, so it is cached.
  const tinfo = new Map();
  {
    const ownFree = new Map();
    const includesOf = new Map();
    for (const [name, nodes] of templates) {
      const free = new Set();
      const incs = new Set();
      const walk = (ns, bound) => {
        for (const node of ns) {
          if (node.k === 1 || node.k === 2) {
            if (!bound.has(node.path[0])) free.add(node.path[0]);
          }
          if (node.k === 2) {
            walk(node.then, bound);
            if (node.els !== null) walk(node.els, bound);
          } else if (node.k === 3) {
            if (!bound.has(node.path[0])) free.add(node.path[0]);
            const inner = new Set(bound);
            inner.add(node.name);
            inner.add('loop');
            walk(node.body, inner);
          } else if (node.k === 4) {
            incs.add(node.name);
          }
        }
      };
      walk(nodes, new Set());
      ownFree.set(name, free);
      includesOf.set(name, incs);
    }
    const freeOf = new Map([...ownFree].map(([name, free]) => [name, new Set(free)]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, incs] of includesOf) {
        const acc = freeOf.get(name);
        for (const inc of incs) {
          const sub = freeOf.get(inc);
          if (sub === undefined) continue;
          for (const f of sub) {
            if (!acc.has(f)) {
              acc.add(f);
              changed = true;
            }
          }
        }
      }
    }
    for (const [name, free] of freeOf) {
      let cacheable = true;
      for (const f of free) {
        if (f !== 'site' && f !== 'tags' && f !== 'recent') {
          cacheable = false;
          break;
        }
      }
      tinfo.set(name, { free, cacheable });
    }
  }
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s.url);
  }

  // Markdown.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const mdCtx = { dir: '', sourcePath: '', bySource, staticPaths, broken, base };
  for (const s of kept) {
    mdCtx.dir = dirOf(s.path);
    mdCtx.sourcePath = s.path;
    const md = renderMarkdown(s.body, mdCtx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const tctx = { templates, info: tinfo, cache: new Map() };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, tctx, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of kept) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
