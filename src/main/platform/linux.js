'use strict';

const { BasePlatform } = require('./base');

class LinuxPlatform extends BasePlatform {
  get id() {
    return 'linux';
  }

  get label() {
    return 'Linux';
  }
}

module.exports = { LinuxPlatform };
