'use strict';
/**
 * 零依赖 JSON 持久化。
 * 单进程写锁 + 原子替换（先写 .tmp 再 rename），崩溃不产生半截文件。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

class Collection {
  constructor(name, defaults) {
    this.name = name;
    this.file = path.join(DATA_DIR, name + '.json');
    this.defaults = defaults || (() => []);
    ensureDir(DATA_DIR);
    this.data = this._load();
    this._writing = false;
    this._pending = false;
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : this.defaults();
    } catch (_) {
      return this.defaults();
    }
  }

  all() {
    return this.data;
  }

  find(pred) {
    return this.data.find(pred) || null;
  }

  filter(pred) {
    return this.data.filter(pred);
  }

  insert(row) {
    this.data.push(row);
    this.save();
    return row;
  }

  update(id, patch) {
    const row = this.find((x) => x.id === id);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return row;
  }

  remove(id) {
    const i = this.data.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.data.splice(i, 1);
    this.save();
    return true;
  }

  /** 原子写：tmp -> rename，避免并发读到半截 JSON。 */
  save() {
    if (this._writing) {
      this._pending = true;
      return;
    }
    this._writing = true;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } finally {
      this._writing = false;
      if (this._pending) {
        this._pending = false;
        this.save();
      }
    }
  }
}

/** 短 ID：前缀 + 时间戳 base36 + 随机 base36，与目标站点同形（如 rpmvgqdexl4lkon4）。 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
function rid(prefix) {
  let s = Date.now().toString(36);
  for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(Math.random() * 36)];
  return (prefix || '') + s;
}

module.exports = { Collection, rid, DATA_DIR, ensureDir };
