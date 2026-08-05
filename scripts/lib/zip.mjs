/**
 * Minimal ZIP writer — no dependencies.
 *
 * `.mrpack` and the plain client archive are both ZIP files, and keeping this
 * in-tree means `git clone && node scripts/build.mjs` works with nothing
 * installed. Scope is deliberately small: buffered entries, deflate or store,
 * no ZIP64 (packs are far below the 4 GiB / 65535-entry limits).
 */

import { deflateRawSync } from 'node:zlib';

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Bit 11 — file names are UTF-8. */
const FLAG_UTF8 = 0x0800;

/**
 * "Version made by": high byte 3 = Unix, low byte = spec version.
 *
 * This has to say Unix, otherwise extractors treat the external-attributes
 * field as DOS flags and drop the permission bits — which silently strips the
 * executable bit off shipped start scripts. Windows ignores the Unix
 * attributes either way, so declaring Unix costs nothing there.
 */
const VERSION_MADE_BY_UNIX = (3 << 8) | 20;

/** Regular-file type bits (S_IFREG), required for the mode to be interpreted. */
const S_IFREG = 0o100000;

const DEFAULT_MODE = 0o644;

// ── CRC-32 (IEEE 802.3, as ZIP requires) ───────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// ── MS-DOS timestamp packing ───────────────────────────────

function dosDateTime(date) {
  const year = date.getFullYear();
  // The DOS epoch starts in 1980 and cannot represent anything earlier.
  const dosYear = Math.max(0, year - 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: (dosYear << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export class ZipWriter {
  #entries = [];
  #chunks = [];
  #offset = 0;

  /**
   * Add one file.
   *
   * @param {string} name  Archive path, always forward-slash separated.
   * @param {Buffer|string} content
   * @param {{ store?: boolean, mtime?: Date, mode?: number }} [options]
   *        `store` skips compression — use it for already-compressed payloads
   *        (jars, pngs, zips) where deflate only burns CPU.
   *        `mode` is the Unix permission bits, e.g. 0o755 for a shell script.
   */
  add(name, content, options = {}) {
    const path = name.replace(/\\/g, '/');
    if (this.#entries.some((e) => e.path === path)) {
      throw new Error(`Duplicate zip entry: ${path}`);
    }

    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const store = options.store ?? false;
    const body = store ? raw : deflateRawSync(raw, { level: 9 });

    // Compression that made the file bigger is worse than useless.
    const useStore = store || body.length >= raw.length;
    const payload = useStore ? raw : body;
    const method = useStore ? METHOD_STORE : METHOD_DEFLATE;

    const nameBuf = Buffer.from(path, 'utf8');
    const { time, date } = dosDateTime(options.mtime ?? new Date());
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    this.#entries.push({
      path,
      nameBuf,
      crc,
      method,
      time,
      date,
      mode: options.mode ?? DEFAULT_MODE,
      compressedSize: payload.length,
      size: raw.length,
      offset: this.#offset,
    });

    this.#chunks.push(local, nameBuf, payload);
    this.#offset += local.length + nameBuf.length + payload.length;

    return this;
  }

  /** Serialise the archive: central directory + end-of-central-directory. */
  toBuffer() {
    const centralStart = this.#offset;
    const central = [];

    for (const entry of this.#entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
      header.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
      header.writeUInt16LE(20, 6); // version needed
      header.writeUInt16LE(FLAG_UTF8, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.nameBuf.length, 28);
      header.writeUInt16LE(0, 30); // extra
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk number start
      header.writeUInt16LE(0, 36); // internal attributes
      // External attributes: Unix mode in the high 16 bits, DOS flags in the low.
      header.writeUInt32LE(((S_IFREG | entry.mode) >>> 0) * 0x10000, 38);
      header.writeUInt32LE(entry.offset, 42);

      central.push(header, entry.nameBuf);
    }

    const centralSize = central.reduce((sum, b) => sum + b.length, 0);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // this disk
    eocd.writeUInt16LE(0, 6); // disk with central directory
    eocd.writeUInt16LE(this.#entries.length, 8);
    eocd.writeUInt16LE(this.#entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20); // comment length

    return Buffer.concat([...this.#chunks, ...central, eocd]);
  }

  get entryCount() {
    return this.#entries.length;
  }
}
