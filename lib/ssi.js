// Minimal SSI renderer for the templates in web/.
//
// The HTML templates use a small subset of Server Side Includes, implemented
// here: set, echo, include, if/else/endif, config and the block/endblock stub
// pair used by pre.html.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DIRECTIVE_RE = /<!--#\s*([a-z]+)\b([\s\S]*?)-->/gi;
const ATTR_RE = /([a-z_]+)="([^"]*)"/gi;

const fileCache = new Map();

async function readTemplate(file) {
  if (!fileCache.has(file)) {
    fileCache.set(file, await readFile(file, 'utf8'));
  }
  return fileCache.get(file);
}

function parseAttrs(source) {
  const attrs = {};
  for (const match of source.matchAll(ATTR_RE)) {
    attrs[match[1].toLowerCase()] = match[2];
  }
  return attrs;
}

function tokenize(source) {
  const parts = [];
  let lastIndex = 0;

  for (const match of source.matchAll(DIRECTIVE_RE)) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: source.slice(lastIndex, match.index) });
    }
    parts.push({
      type: 'directive',
      name: match[1].toLowerCase(),
      attrs: parseAttrs(match[2]),
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < source.length) {
    parts.push({ type: 'text', value: source.slice(lastIndex) });
  }

  return parts;
}

function interpolate(value, state) {
  return String(value)
    .replace(/\$\{([a-z_][a-z0-9_]*)\}/gi, (_, name) => state.vars[name] ?? '')
    .replace(/\$([a-z_][a-z0-9_]*)/gi, (whole, name) =>
      Object.hasOwn(state.vars, name) ? state.vars[name] : whole);
}

function evalExpr(expr, state) {
  if (!expr) return false;

  const match = expr.match(/^\s*\$(\w+)\s*(!?=)\s*\/([\s\S]*)\/\s*$/);
  if (!match) return false;

  const [, name, operator, rawPattern] = match;
  const value = String(state.vars[name] ?? '');
  const pattern = rawPattern.replace(/\\([\/$])/g, '$1');
  const matched = new RegExp(pattern).test(value);
  return operator === '!=' ? !matched : matched;
}

function formatDate(date, format) {
  const pad = (n) => String(n).padStart(2, '0');
  return format.replace(/%[YmdHMS%]/g, (token) => {
    switch (token) {
      case '%Y': return String(date.getFullYear());
      case '%m': return pad(date.getMonth() + 1);
      case '%d': return pad(date.getDate());
      case '%H': return pad(date.getHours());
      case '%M': return pad(date.getMinutes());
      case '%S': return pad(date.getSeconds());
      case '%%': return '%';
      default: return token;
    }
  });
}

async function renderFile(file, state) {
  const source = await readTemplate(file);
  return renderParts(tokenize(source), file, state);
}

async function renderParts(parts, file, state) {
  let output = '';
  let active = true;
  const stack = [];

  for (const part of parts) {
    if (part.type === 'text') {
      if (active) output += part.value;
      continue;
    }

    const { name, attrs } = part;

    switch (name) {
      case 'if': {
        const condition = active && evalExpr(attrs.expr, state);
        stack.push({ parentActive: active, condition });
        active = condition;
        break;
      }

      case 'else': {
        const top = stack.at(-1);
        if (top) active = top.parentActive && !top.condition;
        break;
      }

      case 'endif':
        if (stack.length) active = stack.pop().parentActive;
        break;

      case 'set':
        if (active && attrs.var) {
          state.vars[attrs.var] = interpolate(attrs.value ?? '', state);
        }
        break;

      case 'config':
        if (active && attrs.timefmt) state.timefmt = attrs.timefmt;
        break;

      case 'echo': {
        if (!active) break;
        const value = attrs.var === 'date_local'
          ? formatDate(new Date(), state.timefmt || '%Y-%m-%d %H:%M:%S')
          : state.vars[attrs.var] ?? attrs.default ?? '';
        output += value;
        break;
      }

      case 'include': {
        if (!active || !attrs.file) break;
        const target = path.resolve(path.dirname(file), attrs.file);
        try {
          output += await renderFile(target, state);
        } catch (error) {
          // Missing includes (e.g. the optional
          // meta.html stub) produce no output.
          if (error.code !== 'ENOENT') throw error;
        }
        break;
      }

      // The block/endblock pair only provides stub content for missing
      // includes. Both stubs in this project are empty, so ignoring them is
      // equivalent.
      case 'block':
      case 'endblock':
        break;

      default:
        break;
    }
  }

  return output;
}

/**
 * Render a template from the web/ directory.
 *
 * @param {string} webRoot absolute path to the web directory
 * @param {string} template path relative to webRoot, e.g. "internal/error.html"
 * @param {Record<string, string>} vars initial SSI variables
 * @returns {Promise<string>}
 */
export async function renderTemplate(webRoot, template, vars) {
  const file = path.resolve(webRoot, template);
  const root = path.resolve(webRoot);

  if (!file.startsWith(root + path.sep)) {
    throw new Error(`template escapes web root: ${template}`);
  }

  return renderFile(file, { vars: { ...vars }, timefmt: '' });
}

export function clearTemplateCache() {
  fileCache.clear();
}
