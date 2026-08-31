'use strict';

const os = require('os');
const path = require('path');

/** Shared behavior for supported desktop platforms. */
class BasePlatform {
  constructor({ env = process.env, homedir = os.homedir } = {}) {
    this.env = env;
    this._homedir = homedir;
  }

  get id() {
    return 'unknown';
  }

  get label() {
    return this.id;
  }

  homeDir() {
    return path.resolve(this._homedir());
  }

  sshDirectory() {
    return path.join(this.homeDir(), '.ssh');
  }

  sshConfigPath() {
    return path.join(this.sshDirectory(), 'config');
  }

  /** Expand only a current-user home marker; never reinterpret remote paths. */
  expandLocalPath(value) {
    const cleaned = String(value || '').trim().replace(/^"|"$/g, '');
    if (cleaned === '~') return this.homeDir();
    if (cleaned.startsWith('~/') || cleaned.startsWith('~\\')) {
      return path.join(this.homeDir(), ...cleaned.slice(2).split(/[\\/]+/));
    }
    return cleaned;
  }

  detectSshAgent() {
    return this.env.SSH_AUTH_SOCK || null;
  }

  shouldQuitOnWindowClose() {
    return true;
  }
}

module.exports = { BasePlatform };
