#!/usr/bin/env node
/**
 * Prints one provider key's macOS Keychain value, or nothing. The items it
 * looks in are listed in scripts/lib/credentials.mjs.
 *
 * Usage: node scripts/read-keychain-value.mjs OPENAI_API_KEY
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKeychainValue } from './lib/credentials.mjs';

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.stdout.write(readKeychainValue(process.argv[2]));
}
