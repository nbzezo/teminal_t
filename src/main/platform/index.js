'use strict';

const { BasePlatform } = require('./base');
const { WindowsPlatform } = require('./windows');
const { LinuxPlatform } = require('./linux');

function createPlatform(platformId = process.platform, options = {}) {
  if (platformId === 'win32') return new WindowsPlatform(options);
  if (platformId === 'linux') return new LinuxPlatform(options);
  return new BasePlatform(options);
}

const currentPlatform = createPlatform();

module.exports = { createPlatform, currentPlatform };
