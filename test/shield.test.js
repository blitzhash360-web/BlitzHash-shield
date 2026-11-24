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
  inspectPath,
  stripSourceMaps,
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
    assert.equal(proc.stdout.trim(), '2.0.0');
  });
});


describe('inspect and strip-maps', () => {
  const leaky = path.join(__dirname, '..', 'fixtures', 'leaky-dist');

  it('flags source maps, sourceMappingURL and debugger in the bundled fixture', () => {
    const report = inspectPath(leaky);
    const ids = report.findings.map((f) => f.id);
    assert.ok(ids.includes('source_map_file'), ids);
    assert.ok(ids.includes('source_mapping_url'), ids);
    assert.ok(ids.includes('debugger'), ids);
    assert.ok(report.residual.length >= 3);
    for (const f of report.findings) assert.equal(typeof f.advice, 'string');
  });

  it('flags a secret-shaped string in a temp file and never prints the value', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'bundle.js');
    // Built at test time so no secret-shaped token is committed to the repo.
    const token = 'sk_live_' + 'A'.repeat(24);
    fs.writeFileSync(file, 'const k = "' + token + '";\n');
    const report = inspectPath(dir);
    const secrets = report.findings.filter((f) => f.id.startsWith('secret_'));
    assert.ok(secrets.length >= 1, report.findings.map((f) => f.id));
    const dumped = JSON.stringify(report.findings);
    assert.ok(!dumped.includes(token), dumped);
    for (const f of secrets) {
      assert.ok(!f.title.includes('sk_live_'));
      assert.ok(!f.detail.includes(token));
      assert.ok(!f.advice.includes(token));
    }
  });

  it('CLI inspect --json lists findings and --fail exits 1', () => {
    const proc = spawnSync(process.execPath, [bin, 'inspect', leaky, '--json', '--no-color'], { encoding: 'utf8' });
    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
    const report = JSON.parse(proc.stdout);
    assert.ok(report.findings.length >= 3);
    const fail = spawnSync(process.execPath, [bin, 'inspect', leaky, '--fail', '--no-color'], { encoding: 'utf8' });
    assert.equal(fail.status, 1, fail.stderr || fail.stdout);
    assert.ok(fail.stdout.includes('Source map') || fail.stdout.includes('sourceMappingURL') || fail.stdout.includes('secret'));
    assert.ok(fail.stdout.includes('not unbreakable') || fail.stdout.includes('determined human'));
  });

  it('strip-maps removes the map file and the comment (copy first)', () => {
    const dir = tmpDir();
    const js = path.join(dir, 'app.js');
    const map = path.join(dir, 'app.js.map');
    fs.writeFileSync(js, 'function hi() { return 1; }\n//# sourceMappingURL=app.js.map\n');
    fs.writeFileSync(map, '{"version":3,"file":"app.js","sources":["app.js"],"mappings":""}\n');
    const result = stripSourceMaps(dir);
    assert.equal(result.deletedMaps.length, 1);
    assert.equal(result.strippedComments.length, 1);
    assert.ok(!fs.existsSync(map));
    const after = fs.readFileSync(js, 'utf8');
    assert.ok(!after.includes('sourceMappingURL'));
  });

  it('obfuscation strips sourceMappingURL and --in-place overwrites the file', () => {
    const dir = tmpDir();
    const input = path.join(dir, 'app.js');
    const original = '(function () { function add(a, b) { return a + b; } return add(1, 2); })();\n//# sourceMappingURL=app.js.map\n';
    fs.writeFileSync(input, original);
    const { shieldFile } = require('../src');
    const result = shieldFile(input, { seed: 9, inPlace: true, decoys: false });
    assert.equal(result.outputPath, input);
    const written = fs.readFileSync(input, 'utf8');
    assert.ok(!written.includes('sourceMappingURL'));
    assert.ok(!written.includes('function add'));
    assert.notEqual(written, original);
  });
});
