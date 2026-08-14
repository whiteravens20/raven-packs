/**
 * Build Minecraft's `servers.dat` — the multiplayer list the client reads at
 * startup — so a fresh install already has the server in it.
 *
 * The format was read out of the 26.2 client rather than recalled. `ServerList`
 * uses `NbtIo.read`/`NbtIo.write`, not the `*Compressed` pair, so the file is
 * **uncompressed** NBT. `NbtIo.write` delegates to `writeUnnamedTag`, which
 * writes the type byte, then `writeUTF("")` for the root name, then the
 * payload — the classic named-root encoding with a zero-length name, not the
 * nameless network variant.
 *
 * `ServerData.write()` stores `name` and `ip` as strings; `icon`,
 * `acceptedCodeOfConduct` and the resource-pack status are written through
 * codecs and are all optional on the way back in (`getListOrEmpty`,
 * `getBooleanOr`). So name and ip are the whole minimum, and leaving the icon
 * out is deliberate: the server sends its own `server-icon.png` on the first
 * ping and the client caches it, which beats baking a copy into every install
 * that then goes stale the day the icon changes.
 */

/** Java's `DataOutput.writeUTF`: two-byte length, then modified UTF-8. */
function javaUTF(str) {
  const body = Buffer.from(str, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length);
  return Buffer.concat([len, body]);
}

const TAG_END = 0x00;
const TAG_STRING = 0x08;
const TAG_LIST = 0x09;
const TAG_COMPOUND = 0x0a;

/** A named TAG_String inside a compound. */
function stringField(name, value) {
  return Buffer.concat([Buffer.from([TAG_STRING]), javaUTF(name), javaUTF(value)]);
}

/**
 * @param {Array<{name: string, ip: string}>} servers
 * @returns {Buffer} the bytes of a `servers.dat`
 */
export function buildServersDat(servers) {
  const entries = servers.map((s) =>
    Buffer.concat([stringField('name', s.name), stringField('ip', s.ip), Buffer.from([TAG_END])]),
  );

  const count = Buffer.alloc(4);
  count.writeInt32BE(entries.length);

  const list = Buffer.concat([
    Buffer.from([TAG_LIST]),
    javaUTF('servers'),
    Buffer.from([TAG_COMPOUND]), // element type
    count,
    ...entries,
  ]);

  return Buffer.concat([
    Buffer.from([TAG_COMPOUND]),
    javaUTF(''), // root name — empty, but present
    list,
    Buffer.from([TAG_END]), // closes the root compound
  ]);
}

/**
 * `pack.server` as the client should see it.
 *
 * Minecraft treats a bare host as port 25565, so the port is only appended
 * when it differs — a list entry reading `example.com:25565` is noise.
 */
export function serverAddress({ ip, port }) {
  return !port || port === 25565 ? ip : `${ip}:${port}`;
}
