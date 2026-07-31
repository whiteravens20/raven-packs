#!/usr/bin/env node
/**
 * Generate an Ed25519 keypair for signing pack manifests.
 *
 *   node scripts/keygen.mjs [name]
 *
 * Writes keys/<name>.key (private, keep secret) and keys/<name>.pub (public,
 * hand this to players). Uses node:crypto — the launcher verifies with
 * tweetnacl, and both speak raw 32-byte Ed25519 keys, so the two interoperate.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Strip DER wrapping to the raw key bytes tweetnacl expects.
 *
 * Ed25519 DER blobs have fixed-length prefixes, so the raw key is simply the
 * tail: 32 bytes for a public key, 32 for a private seed.
 */
function rawPublicKey(keyObject) {
  const der = keyObject.export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32);
}

function rawPrivateSeed(keyObject) {
  const der = keyObject.export({ type: 'pkcs8', format: 'der' });
  return der.subarray(der.length - 32);
}

async function main() {
  const name = process.argv[2] ?? 'ravenpacks';
  const keysDir = path.join(ROOT, 'keys');
  await fs.mkdir(keysDir, { recursive: true });

  const privatePath = path.join(keysDir, `${name}.key`);
  const publicPath = path.join(keysDir, `${name}.pub`);

  // Never silently clobber a signing key.
  for (const file of [privatePath, publicPath]) {
    try {
      await fs.access(file);
      console.error(`✗ ${path.relative(ROOT, file)} already exists — refusing to overwrite.`);
      console.error('  Delete it first if you really mean to rotate the key.');
      process.exit(1);
    } catch { /* does not exist — good */ }
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  const publicB64 = rawPublicKey(publicKey).toString('base64');
  // tweetnacl's secret key is seed(32) || publicKey(32).
  const secretB64 = Buffer.concat([rawPrivateSeed(privateKey), rawPublicKey(publicKey)]).toString('base64');

  await fs.writeFile(privatePath, `${secretB64}\n`, { mode: 0o600 });
  await fs.writeFile(publicPath, `${publicB64}\n`);

  console.log(`✓ private key → ${path.relative(ROOT, privatePath)}  (chmod 600, never commit)`);
  console.log(`✓ public key  → ${path.relative(ROOT, publicPath)}`);
  console.log('\nPublic key (players add this under Settings → Trusted Keys):\n');
  console.log(`  ${publicB64}\n`);
  console.log('For CI, store the private key as a repository secret:');
  console.log(`  gh secret set PACK_SIGNING_KEY < ${path.relative(ROOT, privatePath)}`);
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
