'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '.hg', '.svn', 'coverage', '.cache', '.turbo', '.vercel',
]);

const SECRET_PATTERNS = [
  { id: 'stripe_live', label: 'Stripe live secret key', re: /\bsk_live_[A-Za-z0-9]{16,}/ },
  { id: 'stripe_test', label: 'Stripe test secret key', re: /\bsk_test_[A-Za-z0-9]{16,}/ },
  { id: 'stripe_whsec', label: 'Stripe webhook secret', re: /\bwhsec_[A-Za-z0-9]{20,}/ },
  { id: 'aws_access_key', label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github_token', label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { id: 'openai_key', label: 'OpenAI-style key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { id: 'google_api_key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'private_key', label: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'supabase_service', label: 'Supabase service-role-shaped JWT', re: /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./ },
];

const SOURCEMAP_COMMENT = /(?:\/\/[#@]|\/\*)\s*sourceMappingURL\s*=\s*(\S+)/;
const SOURCE_URL_COMMENT = /(?:\/\/[#@]|\/\*)\s*sourceURL\s*=\s*(\S+)/;
const INLINE_MAP = /sourceMappingURL\s*=\s*data:application\/json/;

const JS_EXT = /\.(js|mjs|cjs|css)$/i;
const MAP_EXT = /\.map$/i;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    out.push(dir);
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function stripSourceMapComments(source) {
  const lines = source.split('\n');
  const kept = lines.filter((line) => !/^\s*\/\/[#@]\s*source(MappingURL|URL)\s*=/.test(line)
    && !/^\s*\/\*[#@]?\s*source(MappingURL|URL)\s*=/.test(line));
  return kept.join('\n');
}

/**
 * Remove .map files and sourceMappingURL / sourceURL comments under a file or directory.
 * @returns {{strippedComments: string[], deletedMaps: string[]}}
 */
function stripSourceMaps(input, options = {}) {
  const files = walk(input);
  const strippedComments = [];
  const deletedMaps = [];
  for (const file of files) {
    if (MAP_EXT.test(file) && !options.keepMaps) {
      if (!options.dryRun) fs.unlinkSync(file);
      deletedMaps.push(file);
      continue;
    }
    if (!JS_EXT.test(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (!SOURCEMAP_COMMENT.test(src) && !SOURCE_URL_COMMENT.test(src) && !INLINE_MAP.test(src)) continue;
    const next = stripSourceMapComments(src);
    if (next !== src) {
      if (!options.dryRun) fs.writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
      strippedComments.push(file);
    }
  }
  return { strippedComments, deletedMaps };
}

function inspectFile(file, root) {
  const findings = [];
  const rel = root ? path.relative(root, file) : file;
  const base = path.basename(file);

  if (MAP_EXT.test(file)) {
    findings.push({
      id: 'source_map_file',
      severity: 'high',
      title: 'Source map file is in the ship folder',
      file: rel,
      detail: `${base} lets anyone reconstruct your original source, comments and names.`,
      advice: 'Do not upload .map files to production. Keep them private for error tracking if you need them.',
    });
    return findings;
  }

  if (!JS_EXT.test(file)) return findings;

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return findings;
  }
  const sample = text.slice(0, 800_000);

  if (INLINE_MAP.test(sample)) {
    findings.push({
      id: 'inline_source_map',
      severity: 'high',
      title: 'Inline source map embedded in a shipped file',
      file: rel,
      detail: 'The file contains a data: source map, so the original source is inside the download.',
      advice: 'Rebuild without inline source maps and strip sourceMappingURL comments before you ship.',
    });
  }

  const mapComment = sample.match(SOURCEMAP_COMMENT);
  if (mapComment) {
    findings.push({
      id: 'source_mapping_url',
      severity: 'high',
      title: 'sourceMappingURL comment points at a map',
      file: rel,
      detail: `The file points at ${mapComment[1]}. If that map is public, a human can recover your source.`,
      advice: 'Strip the comment and do not serve the .map file on the production host.',
    });
  }

  if (SOURCE_URL_COMMENT.test(sample)) {
    findings.push({
      id: 'source_url',
      severity: 'medium',
      title: 'sourceURL comment is still in the file',
      file: rel,
      detail: 'DevTools will show the original name, which makes stepping through the code easier.',
      advice: 'Strip sourceURL comments from the production bundle.',
    });
  }

  if (/\bdebugger\b/.test(sample)) {
    findings.push({
      id: 'debugger',
      severity: 'medium',
      title: 'A debugger statement is still in the bundle',
      file: rel,
      detail: 'DevTools will pause on this, and it is a strong hint the file was not prepared for production.',
      advice: 'Remove debugger statements before you ship.',
    });
  }

  if (/webpack:\/\//.test(sample) || /\/src\/[A-Za-z0-9_./-]+\.[jt]sx?/.test(sample.slice(0, 20_000))) {
    findings.push({
      id: 'original_paths',
      severity: 'medium',
      title: 'Original source paths are still readable',
      file: rel,
      detail: 'The file still contains webpack:// or /src/... paths, which help a human map the bundle back to your repo.',
      advice: 'Ship a production build with comments and path hints stripped.',
    });
  }

  for (const pat of SECRET_PATTERNS) {
    if (pat.re.test(sample)) {
      findings.push({
        id: `secret_${pat.id}`,
        severity: 'critical',
        title: `${pat.label} appears in a client file`,
        file: rel,
        detail: 'Anything in a browser download can be copied. Obfuscation does not hide this.',
        advice: 'Move the secret to the server, rotate it, and treat the old value as leaked. This tool never prints the value.',
      });
    }
  }

  const size = sample.length;
  if (size >= 2048) {
    const newlines = (sample.match(/\n/g) || []).length;
    const namedFns = (sample.match(/\bfunction\s+[A-Za-z_][A-Za-z0-9_]{3,}/g) || []).length;
    if (newlines > size / 80 && namedFns >= 3) {
      findings.push({
        id: 'unminified',
        severity: 'low',
        title: 'This file still looks like readable source, not a production bundle',
        file: rel,
        detail: 'A human can skim function names and structure without a formatter.',
        advice: 'Run your bundler in production mode, then optionally run Shield on the output.',
      });
    }
  }

  return findings;
}

/**
 * Read-only report of what a curious human can still see in a ship folder or file.
 */
function inspectPath(input) {
  const stat = fs.statSync(input);
  const root = stat.isDirectory() ? input : path.dirname(input);
  const files = walk(input);
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    if (!JS_EXT.test(file) && !MAP_EXT.test(file)) continue;
    scanned += 1;
    findings.push(...inspectFile(file, root));
  }
  const residual = [
    'Open DevTools and read every request the app makes, including URLs, headers and bodies.',
    'Pretty-print or beautify the bundle. Obfuscation slows this down; it does not stop it.',
    'Copy any secret, flag or business rule you left in client JavaScript — those still ship to the browser.',
    'Replay public API calls. Authorization has to happen on the server, not in hidden frontend code.',
  ];
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9));
  return {
    ok: findings.every((f) => f.severity === 'low'),
    target: input,
    filesScanned: scanned,
    findings,
    residual,
  };
}

function formatInspect(report, { color = false } = {}) {
  const wrap = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  const bold = wrap('1');
  const dim = wrap('2');
  const red = wrap('31');
  const yellow = wrap('33');
  const cyan = wrap('36');
  const lines = [];
  lines.push(bold('BlitzHash Shield inspect') + dim(' — what a human can still see in your shipped client files'));
  lines.push('');
  lines.push(`target    ${report.target}`);
  lines.push(`scanned   ${report.filesScanned} file${report.filesScanned === 1 ? '' : 's'}`);
  lines.push(`findings  ${report.findings.length}`);
  lines.push('');
  if (!report.findings.length) {
    lines.push('No source maps, sourceMappingURL comments or secret-shaped strings were found in this folder.');
  } else {
    for (const f of report.findings) {
      const paint = f.severity === 'critical' || f.severity === 'high' ? red : f.severity === 'medium' ? yellow : cyan;
      lines.push(`${paint(f.severity.toUpperCase().padEnd(8))} ${f.title}`);
      lines.push(dim(`         ${f.file}`));
      lines.push(dim(`         ${f.detail}`));
      lines.push(cyan(`         next: ${f.advice}`));
    }
  }
  lines.push('');
  lines.push(bold('What a determined human can still do'));
  for (const r of report.residual) lines.push(dim(`- ${r}`));
  lines.push('');
  lines.push(dim('Obfuscation raises the cost of casual copying. It is not unbreakable. Secrets belong on the server.'));
  lines.push(dim('Built by BlitzHash · https://blitzhash.com'));
  return lines.join('\n');
}

module.exports = {
  inspectPath,
  inspectFile,
  stripSourceMaps,
  stripSourceMapComments,
  formatInspect,
  SECRET_PATTERNS,
};
