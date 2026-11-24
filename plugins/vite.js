'use strict';

const path = require('path');
const { inspectPath, stripSourceMaps, formatInspect, shieldPaths } = require('../src');

/**
 * Vite plugin: after the production build, strip source maps (default),
 * optionally inspect what a human can still see, and optionally obfuscate.
 *
 * Obfuscation is off by default because it can break some apps. Inspect and
 * map stripping are the safe first step.
 *
 * @param {object} [options]
 * @param {boolean} [options.stripMaps=true]
 * @param {boolean} [options.inspect=true]
 * @param {boolean} [options.obfuscate=false]
 * @param {boolean} [options.decoys=true]
 * @param {boolean} [options.failOnFindings=false] fail the build on high/critical findings
 * @param {string} [options.dir] override outDir
 */
function blitzhashShield(options = {}) {
  let outDir = 'dist';
  return {
    name: 'blitzhash-shield',
    apply: 'build',
    configResolved(config) {
      outDir = options.dir || (config.build && config.build.outDir) || 'dist';
    },
    closeBundle() {
      const dir = path.resolve(outDir);
      if (options.stripMaps !== false) {
        const stripped = stripSourceMaps(dir);
        const n = stripped.deletedMaps.length + stripped.strippedComments.length;
        if (n) {
          console.log(`[blitzhash-shield] stripped ${stripped.deletedMaps.length} map file(s) and ${stripped.strippedComments.length} sourceMappingURL comment(s)`);
        }
      }
      if (options.obfuscate) {
        shieldPaths(dir, { decoys: options.decoys !== false, inPlace: true });
        console.log('[blitzhash-shield] obfuscated JS in', dir);
      }
      if (options.inspect !== false) {
        const report = inspectPath(dir);
        console.log(formatInspect(report, { color: Boolean(process.stdout.isTTY) }));
        const blocking = report.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
        if (options.failOnFindings && blocking.length) {
          throw new Error(`blitzhash-shield: ${blocking.length} high or critical inspect finding(s)`);
        }
      }
    },
  };
}

module.exports = blitzhashShield;
module.exports.blitzhashShield = blitzhashShield;
module.exports.default = blitzhashShield;
