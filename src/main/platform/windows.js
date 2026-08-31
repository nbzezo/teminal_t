'use strict';

const fs = require('fs');
const { BasePlatform } = require('./base');

const OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

class WindowsPlatform extends BasePlatform {
  constructor(options = {}) {
    super(options);
    this._existsSync = options.existsSync || fs.existsSync;
  }

  get id() {
    return 'win32';
  }

  get label() {
    return 'Windows';
  }

  detectSshAgent() {
    const configured = super.detectSshAgent();
    if (configured) return configured;
    return this._existsSync(OPENSSH_AGENT_PIPE) ? OPENSSH_AGENT_PIPE : null;
  }
}

module.exports = { WindowsPlatform, OPENSSH_AGENT_PIPE };
