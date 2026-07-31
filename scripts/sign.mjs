#!/usr/bin/env node
/**
 * Sign a built manifest in place with an Ed25519 key.
 *
 *   node scripts/sign.mjs dist/ravenmc/manifest.json keys/ravenpacks.key
 *   PACK_SIGNING_KEY="<base64>" node scripts/sign.mjs dist/ravenmc/manifest.json
 *
 * Adds a `signature` field over the canonical form of everything else. The
 * launcher recomputes that same canonical form and checks it against the
 * public keys the player has trusted.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalize } from './lib/canonical.mjs';

/** Rebuild a DER-wrapped private key from tweetnacl's raw 64-byte secret. */
function privateKeyFromRaw(secret) {
  if (secret.length !== 64 && secret.length !== 32) {
    throw new Error(`Expected a 32- or 64-byte Ed25519 secret, got ${secret.length} bytes`);
  }
  const seed = secret.subarray(0, 32);
  // PKCS#8 prefix for Ed25519 private keys, followed by the 32-byte seed.
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function publicKeyFromPrivate(privateKey) {
  const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32);
}

async function main() {
  const [manifestPath, keyPath] = process.argv.slice(2);

  if (!manifestPath) {
    console.error('usage: node scripts/sign.mjs <manifest.json> [private.key]');
    console.error('       (or set PACK_SIGNING_KEY to the base64 key)');
    process.exit(1);
  }

  let secretB64 = process.env.PACK_SIGNING_KEY;
  if (keyPath) secretB64 = await fs.readFile(keyPath, 'utf8');
  if (!secretB64) {
    throw new Error('No signing key — pass a key file or set PACK_SIGNING_KEY');
  }

  const privateKey = privateKeyFromRaw(Buffer.from(secretB64.trim(), 'base64'));

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const message = Buffer.from(canonicalize(manifest), 'utf8');
  const signature = crypto.sign(null, message, privateKey);

  manifest.signature = signature.toString('base64');
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Verify what we just wrote, so a broken signature can never leave this script.
  const publicKey = publicKeyFromPrivate(privateKey);
  const roundTrip = crypto.verify(
    null,
    Buffer.from(canonicalize(manifest), 'utf8'),
    crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
      format: 'der',
      type: 'spki',
    }),
    signature,
  );
  if (!roundTrip) throw new Error('Signature failed to verify immediately after signing');

  console.log(`✓ signed ${path.basename(manifestPath)}`);
  console.log(`  public key: ${publicKey.toString('base64')}`);
  console.log(`  signature : ${manifest.signature.slice(0, 32)}…`);
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
