'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { shieldPaths, fixturePath, inspectPath, stripSourceMaps, formatInspect } = require('./index');

const pkg = require('../package.json');

function wantsColor({ noColor, forceColor, stdout }) {
  if (noColor) return false;
  if (forceColor) return true;
  const force = process.env.FORCE_COLOR;
  if (force === '0') return false;
  if (force) return true;
  if (process.env.NO_COLOR) return false;
  return Boolean((stdout || process.stdout).isTTY);
}

function paint(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return {
    dim: wrap('2'),
    bold: wrap('1'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('34'),
    magenta: wrap('35'),
    cyan: wrap('36'),
  };
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function printHelp(out = console.log) {
  out(`BlitzHash Shield — raise the cost of reverse-engineering your client JS

Usage:
  npx -y github:blitzhash360-web/BlitzHash-shield <file-or-dir>
  npx -y github:blitzhash360-web/BlitzHash-shield inspect <file-or-dir>
  npx -y github:blitzhash360-web/BlitzHash-shield strip-maps <file-or-dir>
  npx -y github:blitzhash360-web/BlitzHash-shield demo

Commands:
  inspect             Read-only report of source maps, secret-shaped strings and
                      other things a human can still see in a ship folder
  strip-maps          Delete .map files and strip sourceMappingURL comments
  demo                Obfuscate the bundled fixture (writes to a temp folder)
  <file-or-dir>       Obfuscate JS (default command)

Options:
  --out, -o <path>    Write to this file (single input) or directory
  --in-place          Overwrite the input files (for a dist folder after a build)
  --no-decoys         Obfuscate only; skip anti-LLM decoy strings
  --dry-run           Print or report, and do not write files
  --fail              inspect: exit 1 if any high or critical finding
  --json              Machine-readable report
  --no-color          Disable ANSI colors
  --demo, demo        Run the obfuscation demo
  --version, -v       Print version
  --help, -h          Show help

Exit codes:
  0  Success
  1  Runtime error, or inspect --fail with high/critical findings
  2  Usage / argument error

Honest limits: obfuscation makes client JS harder to skim and harder for an
AI to unpack. It is not unbreakable. A determined human can still pretty-print
the bundle and read every network request. Secrets still belong on the server.

Built by BlitzHash · https://blitzhash.com
`);
}

function parseArgs(argv) {
  const opts = {
    input: null,
    command: 'obfuscate',
    out: null,
    decoys: true,
    dryRun: false,
    json: false,
    noColor: false,
    forceColor: false,
    demo: false,
    inPlace: false,
    fail: false,
    help: false,
    version: false,
    bad: false,
    unknown: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (a === '--demo' || a === 'demo') opts.demo = true;
    else if (a === '--no-decoys') opts.decoys = false;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-color') opts.noColor = true;
    else if (a === '--color' || a === '--force-color') opts.forceColor = true;
    else if (a === '--out' || a === '-o') {
      opts.out = argv[++i];
      if (!opts.out) {
        opts.bad = true;
        opts.unknown = `${a} requires a path`;
      }
    } else if (a.startsWith('--out=')) opts.out = a.slice(6);
    else if (a === '--in-place') opts.inPlace = true;
    else if (a === '--fail') opts.fail = true;
    else if (a.startsWith('-')) {
      opts.bad = true;
      opts.unknown = `Unknown argument: ${a}`;
    } else if ((a === 'inspect' || a === 'strip-maps' || a === 'obfuscate') && opts.command === 'obfuscate' && !opts.input) {
      opts.command = a;
    } else if (!opts.input) opts.input = a;
    else {
      opts.bad = true;
      opts.unknown = `Unexpected argument: ${a}`;
    }
  }
  return opts;
}

function snippet(text, lines = 8, width = 88) {
  return text
    .split('\n')
    .slice(0, lines)
    .map((line) => (line.length > width ? `${line.slice(0, width - 1)}…` : line))
    .join('\n');
}

function previewShielded(code, lines = 8, width = 88) {
  // Display-only: pretty-print the compact preamble so decoy names are readable.
  const splitAt = code.indexOf(';\n');
  let preamble = code;
  let rest = '';
  if (splitAt !== -1 && /^var\s/.test(code)) {
    preamble = code.slice(0, splitAt + 1);
    rest = code.slice(splitAt + 2);
  }
  const pretty = preamble
    .replace(/,(?=[A-Za-z_])/g, ',\n    ')
    .replace(/;function /g, ';\nfunction ');
  const display = rest ? `${pretty}\n${rest}` : pretty;
  return snippet(display, lines, width);
}

function honestyLines() {
  return [
    'Honest limits: this makes client JS harder to skim and harder for an AI',
    'to unpack. It is not unbreakable. Secrets and API keys still belong on',
    'the server. A determined human can still reverse this.',
  ];
}

function formatReport(results, { color, dryRun, demo }) {
  const c = paint(color);
  const lines = [];
  lines.push(c.bold('BlitzHash Shield') + c.dim(' — raise the cost of reverse-engineering your client JS'));
  lines.push('');
  for (const file of results.files) {
    const dest = dryRun ? '(dry run, not written)' : file.outputPath;
    const sourceLabel = demo ? 'fixtures/demo-app.js' : file.inputPath;
    if (demo) {
      lines.push(`${c.cyan('demo')}     bundled fixture (copied to a temp folder)`);
    }
    lines.push(`${c.cyan('source')}   ${sourceLabel}`);
    lines.push(`${c.green('wrote')}    ${dest}`);
    lines.push(`${c.dim('size')}     ${formatBytes(file.bytesIn)} → ${formatBytes(file.bytesOut)}`);
    if (file.decoysInjected.length) {
      lines.push(`${c.yellow('decoys')}   ${file.decoysInjected.length} anti-LLM identifiers injected`);
      for (const name of file.decoysInjected.slice(0, 8)) {
        lines.push(`          ${c.dim('·')} ${name}`);
      }
      if (file.decoysInjected.length > 8) {
        lines.push(`          ${c.dim(`· …and ${file.decoysInjected.length - 8} more`)}`);
      }
    } else {
      lines.push(`${c.dim('decoys')}   skipped (--no-decoys)`);
    }
    lines.push('');
    if (results.files.length === 1) {
      const original = fs.readFileSync(file.inputPath, 'utf8');
      lines.push(c.bold('before'));
      lines.push(c.dim(snippet(original, 16)));
      lines.push('');
      lines.push(c.bold('after'));
      lines.push(c.dim(previewShielded(file.code, 8)));
      lines.push('');
    }
  }
  for (const line of honestyLines()) lines.push(c.dim(line));
  lines.push('');
  lines.push(c.dim('Built by BlitzHash · https://blitzhash.com'));
  return lines.join('\n');
}

function runDemo(options) {
  const src = fixturePath();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blitzhash-shield-'));
  const input = path.join(tmp, 'demo-app.js');
  const out = path.join(tmp, 'demo-app.shield.js');
  fs.copyFileSync(src, input);
  return shieldPaths(input, { ...options, out, dryRun: false });
}

async function main(argv, io = {}) {
  const log = io.log || console.log;
  const err = io.err || console.error;
  const opts = parseArgs(argv);

  if (opts.version) {
    log(pkg.version);
    return 0;
  }
  if (opts.bad) {
    if (opts.unknown) err(opts.unknown);
    printHelp(err);
    return 2;
  }
  if (opts.help) {
    printHelp(log);
    return 0;
  }
  if (!opts.demo && !opts.input) {
    printHelp(err);
    return 2;
  }

  const color = wantsColor({
    noColor: opts.noColor,
    forceColor: opts.forceColor,
    stdout: io.stdout || process.stdout,
  });

  if (opts.command === 'inspect') {
    if (!opts.input) {
      err('inspect needs a file or directory');
      printHelp(err);
      return 2;
    }
    const report = inspectPath(opts.input);
    if (opts.json) {
      log(JSON.stringify({ ok: report.ok, target: report.target, filesScanned: report.filesScanned, findings: report.findings, residual: report.residual }, null, 2));
    } else {
      log(formatInspect(report, { color }));
    }
    const blocking = report.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
    if (opts.fail && blocking.length) return 1;
    return 0;
  }

  if (opts.command === 'strip-maps') {
    if (!opts.input) {
      err('strip-maps needs a file or directory');
      printHelp(err);
      return 2;
    }
    const result = stripSourceMaps(opts.input, { dryRun: opts.dryRun });
    if (opts.json) {
      log(JSON.stringify({ ok: true, dryRun: Boolean(opts.dryRun), ...result }, null, 2));
    } else {
      log(`BlitzHash Shield strip-maps${opts.dryRun ? ' (dry run)' : ''}`);
      log(`deleted maps     ${result.deletedMaps.length}`);
      log(`stripped comments ${result.strippedComments.length}`);
      for (const f of result.deletedMaps) log(`  map  ${f}`);
      for (const f of result.strippedComments) log(`  js   ${f}`);
      log('Built by BlitzHash · https://blitzhash.com');
    }
    return 0;
  }

  const runOptions = {
    decoys: opts.decoys,
    out: opts.out,
    dryRun: opts.dryRun && !opts.demo,
    inPlace: opts.inPlace,
  };

  const results = opts.demo ? runDemo(runOptions) : shieldPaths(opts.input, runOptions);

  if (opts.dryRun && !opts.demo) {
    for (const file of results.files) {
      if (results.files.length > 1) {
        log(`// ${file.inputPath}`);
      }
      log(file.code.replace(/\n$/, ''));
    }
    return 0;
  }

  if (opts.json) {
    log(JSON.stringify({
      ok: true,
      demo: Boolean(opts.demo),
      files: results.files.map((f) => ({
        inputPath: f.inputPath,
        outputPath: f.outputPath,
        bytesIn: f.bytesIn,
        bytesOut: f.bytesOut,
        decoysInjected: f.decoysInjected,
      })),
    }, null, 2));
    return 0;
  }

  log(formatReport(results, {
    color,
    dryRun: Boolean(opts.dryRun && !opts.demo),
    demo: Boolean(opts.demo),
  }));
  return 0;
}

module.exports = { main, parseArgs, formatReport, printHelp };
