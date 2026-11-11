'use strict';

const fs = require('fs');
const path = require('path');
const decoys = require('./decoys');
const { obfuscateSource, defaultOptions } = require('./obfuscate');

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'coverage',
  '.next',
  '.cache',
  '.turbo',
  '.vercel',
]);

function splitShebang(source) {
  if (source.startsWith('#!')) {
    const i = source.indexOf('\n');
    if (i === -1) return { shebang: `${source}\n`, body: '' };
    return { shebang: source.slice(0, i + 1), body: source.slice(i + 1) };
  }
  return { shebang: '', body: source };
}

/**
 * Obfuscate a JavaScript source string and optionally inject anti-LLM decoys.
 *
 * @param {string} source
 * @param {object} [options]
 * @param {boolean} [options.decoys=true]
 * @param {number} [options.seed]
 * @param {object} [options.obfuscator] extra javascript-obfuscator options
 * @param {string} [options.sourceFileName]
 * @param {string[]} [options.identifiers]
 * @param {string[]} [options.strings]
 * @returns {{code: string, decoysInjected: string[], bytesIn: number, bytesOut: number, sourceFileName: string|null}}
 */
function shieldSource(source, options = {}) {
  if (typeof source !== 'string') {
    throw new TypeError('shieldSource() expects a string');
  }
  const useDecoys = options.decoys !== false;
  const identifiers = options.identifiers || decoys.IDENTIFIERS;
  const strings = options.strings || decoys.STRINGS;
  const { shebang, body } = splitShebang(source);

  let prepared = body;
  if (useDecoys) {
    prepared = decoys.injectDeadCode(prepared, identifiers, strings);
  }

  const reservedNames = useDecoys ? decoys.reservedNamePatterns(identifiers) : [];
  const obfuscated = obfuscateSource(prepared, {
    reservedNames,
    seed: options.seed,
    obfuscator: options.obfuscator,
  });

  let code = obfuscated;
  const decoysInjected = [];
  if (useDecoys) {
    code = decoys.wrapWithPreamble(obfuscated, identifiers, strings);
    decoysInjected.push(...identifiers);
  }
  code = shebang + code;
  if (!code.endsWith('\n')) code += '\n';

  return {
    code,
    decoysInjected,
    bytesIn: Buffer.byteLength(source),
    bytesOut: Buffer.byteLength(code),
    sourceFileName: options.sourceFileName || null,
  };
}

function defaultOutputPath(inputPath) {
  const ext = path.extname(inputPath);
  const base = ext ? inputPath.slice(0, inputPath.length - ext.length) : inputPath;
  return `${base}.shield${ext || '.js'}`;
}

function looksLikeJsFile(filePath) {
  return /\.(js|mjs|cjs)$/i.test(filePath);
}

function isShieldOutput(filePath) {
  return /\.shield\.(js|mjs|cjs)$/i.test(filePath);
}

function isJsFile(filePath) {
  return looksLikeJsFile(filePath) && !isShieldOutput(filePath);
}

/**
 * Obfuscate a file and write `*.shield.js` (or options.out).
 *
 * @param {string} inputPath
 * @param {object} [options]
 * @param {string} [options.out]
 * @param {boolean} [options.dryRun]
 * @returns {object}
 */
function shieldFile(inputPath, options = {}) {
  const source = fs.readFileSync(inputPath, 'utf8');
  const result = shieldSource(source, { ...options, sourceFileName: inputPath });
  const outputPath = options.out || defaultOutputPath(inputPath);
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, result.code, 'utf8');
  }
  return { ...result, inputPath, outputPath };
}

function collectFiles(input) {
  const stat = fs.statSync(input);
  if (stat.isFile()) {
    if (!isJsFile(input)) {
      throw new Error(`Not a JavaScript file: ${input}`);
    }
    return [input];
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a file or directory: ${input}`);
  }
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile() && isJsFile(entry.name)) {
        out.push(full);
      }
    }
  }
  walk(input);
  return out.sort();
}

function resolveOutPath(inputFile, inputRoot, out, singleFile) {
  if (!out) return defaultOutputPath(inputFile);
  if (singleFile && looksLikeJsFile(out)) return out;
  const rel = path.relative(inputRoot, inputFile);
  return defaultOutputPath(path.join(out, rel));
}

/**
 * Obfuscate a file or every JS file under a directory.
 *
 * @param {string} input file or directory
 * @param {object} [options]
 * @returns {{files: object[]}}
 */
function shieldPaths(input, options = {}) {
  const files = collectFiles(input);
  if (files.length === 0) {
    throw new Error(`No JavaScript files found in ${input}`);
  }
  const root = fs.statSync(input).isDirectory() ? input : path.dirname(input);
  const singleFile = files.length === 1 && fs.statSync(input).isFile();
  const results = files.map((file) => {
    const outPath = resolveOutPath(file, root, options.out, singleFile);
    return shieldFile(file, { ...options, out: outPath });
  });
  return { files: results };
}

function fixturePath() {
  return path.join(__dirname, '..', 'fixtures', 'demo-app.js');
}

module.exports = {
  shieldSource,
  shieldFile,
  shieldPaths,
  collectFiles,
  defaultOutputPath,
  fixturePath,
  IDENTIFIERS: decoys.IDENTIFIERS,
  STRINGS: decoys.STRINGS,
  defaultOptions,
};
