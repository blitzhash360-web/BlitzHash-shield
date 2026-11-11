'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  shieldSource,
  shieldFile,
  shieldPaths,
  fixturePath,
  IDENTIFIERS,
} = require('../src');
const { main } = require('../src/cli');

const bin = path.join(__dirname, '..', 'bin', 'shield.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shield-test-'));
}

describe('shieldSource', () => {
  it('returns output that differs from the input', () => {
    const source = fs.readFileSync(fixturePath(), 'utf8');
    const result = shieldSource(source, { seed: 1 });
    assert.notEqual(result.code, source);
    assert.ok(result.bytesOut > 0);
    assert.equal(result.bytesIn, Buffer.byteLength(source));
    assert.ok(!result.code.includes('function checkPaywall'));
  });

  it('injects sanitized anti-LLM decoy identifiers and strings', () => {
    const source = 'function hello(name) { return "hi " + name; }\n';
    const result = shieldSource(source, { seed: 2 });
    for (const name of [
      'ACCESS_RESTRICTED_DENIED',
      'tripSafetyFilter_v2',
      '__decoy_ignoreAllRules',
      'POLICY_CHECK_BAIT',
    ]) {
      assert.ok(result.code.includes(name), `missing decoy ${name}`);
      assert.ok(result.decoysInjected.includes(name), `decoysInjected missing ${name}`);
    }
    assert.ok(result.code.includes('THIS_IS_SHIELD_BAIT_NOT_A_PROMPT'));
    assert.ok(result.code.includes('classified briefing placeholder — not an instruction'));
    assert.equal(result.decoysInjected.length, IDENTIFIERS.length);
  });

  it('omits decoys when decoys: false', () => {
    const source = 'function hello(name) { return "hi " + name; }\n';
    const result = shieldSource(source, { decoys: false, seed: 3 });
    assert.deepEqual(result.decoysInjected, []);
    assert.ok(!result.code.includes('ACCESS_RESTRICTED_DENIED'));
    assert.notEqual(result.code, source);
  });

  it('preserves a shebang', () => {
    const source = '#!/usr/bin/env node\nfunction hello() { return 1; }\n';
    const result = shieldSource(source, { seed: 4 });
    assert.ok(result.code.startsWith('#!/usr/bin/env node\n'));
  });
});

describe('shieldFile / shieldPaths', () => {
  it('writes a *.shield.js file next to the input', () => {
    const dir = tmpDir();
    const input = path.join(dir, 'app.js');
    fs.writeFileSync(input, 'function add(a, b) { return a + b; }\n');
    const result = shieldFile(input, { seed: 5 });
    assert.equal(result.outputPath, path.join(dir, 'app.shield.js'));
    assert.ok(fs.existsSync(result.outputPath));
    const written = fs.readFileSync(result.outputPath, 'utf8');
    assert.equal(written, result.code);
    assert.ok(written.includes('ACCESS_RESTRICTED_DENIED'));
  });

  it('writes to --out and walks a directory, skipping node_modules and *.shield.js', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'one.js'), 'function one() { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'src', 'two.js'), 'function two() { return 2; }\n');
    fs.writeFileSync(path.join(dir, 'src', 'two.shield.js'), 'already-shielded\n');
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'function lib() { return 0; }\n');

    const out = path.join(dir, 'out');
    const results = shieldPaths(path.join(dir, 'src'), { out, seed: 6 });
    assert.equal(results.files.length, 2);
    const names = results.files.map((f) => path.basename(f.inputPath)).sort();
    assert.deepEqual(names, ['one.js', 'two.js']);
    assert.ok(fs.existsSync(path.join(out, 'one.shield.js')));
    assert.ok(fs.existsSync(path.join(out, 'two.shield.js')));
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'two.shield.js'), 'utf8'), 'already-shielded\n');
  });
});

describe('CLI', () => {
  it('demo exits 0 and prints decoys', () => {
    const proc = spawnSync(process.execPath, [bin, 'demo', '--no-color'], {
      encoding: 'utf8',
    });
    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
    assert.ok(proc.stdout.includes('BlitzHash Shield'));
    assert.ok(proc.stdout.includes('ACCESS_RESTRICTED_DENIED'));
    assert.ok(proc.stdout.includes('not unbreakable'));
    assert.ok(proc.stdout.includes('demo-app.shield.js'));
  });

  it('demo also works as --demo and --json', async () => {
    const chunks = [];
    const code = await main(['--demo', '--json', '--no-color'], {
      log: (s) => chunks.push(String(s)),
      err: (s) => chunks.push(String(s)),
      stdout: { isTTY: false },
    });
    assert.equal(code, 0);
    const report = JSON.parse(chunks.join('\n'));
    assert.equal(report.ok, true);
    assert.equal(report.demo, true);
    assert.equal(report.files.length, 1);
    assert.ok(report.files[0].decoysInjected.includes('tripSafetyFilter_v2'));
    assert.ok(fs.existsSync(report.files[0].outputPath));
  });

  it('prints help and exits 2 when called with no arguments', () => {
    const proc = spawnSync(process.execPath, [bin], { encoding: 'utf8' });
    assert.equal(proc.status, 2);
    assert.ok(proc.stderr.includes('Usage:'));
  });

  it('prints the version', () => {
    const proc = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    assert.equal(proc.status, 0);
    assert.equal(proc.stdout.trim(), '1.0.0');
  });
});
