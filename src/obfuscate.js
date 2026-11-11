'use strict';

const JavaScriptObfuscator = require('javascript-obfuscator');

function defaultOptions({ reservedNames, seed } = {}) {
  const options = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.4,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    reservedNames: reservedNames || [],
    selfDefending: false,
    stringArray: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 0.75,
    stringArrayEncoding: ['base64'],
    splitStrings: true,
    splitStringsChunkLength: 10,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
    target: 'browser',
    sourceMap: false,
    simplify: true,
  };
  if (seed != null) options.seed = seed;
  return options;
}

function obfuscateSource(source, options = {}) {
  const settings = { ...defaultOptions(options), ...(options.obfuscator || {}) };
  if (options.reservedNames) settings.reservedNames = options.reservedNames;
  const result = JavaScriptObfuscator.obfuscate(source, settings);
  return result.getObfuscatedCode();
}

module.exports = { defaultOptions, obfuscateSource };
