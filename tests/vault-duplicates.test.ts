import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCipherDuplicateSignature } from '../webapp/src/lib/vault-duplicates';
import type { Cipher } from '../webapp/src/lib/types';

function loginCipher(overrides: Partial<Cipher> = {}): Cipher {
  return {
    id: overrides.id || 'cipher-1',
    type: 1,
    folderId: overrides.folderId ?? 'folder-a',
    favorite: false,
    reprompt: 0,
    name: 'Example',
    notes: '',
    login: {
      username: 'user@example.com',
      password: 'secret',
      totp: '',
      uris: [{ uri: 'https://example.com', match: null }],
      fido2Credentials: [],
    },
    card: null,
    identity: null,
    sshKey: null,
    secureNote: null,
    fields: [],
    passwordHistory: [],
    ...overrides,
  };
}

test('duplicate signature treats same folder name as same folder even when folder ids differ', () => {
  const first = buildCipherDuplicateSignature(loginCipher({ id: 'one', folderId: 'import-folder-1' }), {
    folderName: 'Work',
  });
  const second = buildCipherDuplicateSignature(loginCipher({ id: 'two', folderId: 'import-folder-2' }), {
    folderName: 'Work',
  });

  assert.equal(second, first);
});

test('duplicate signature still separates different folder names', () => {
  const first = buildCipherDuplicateSignature(loginCipher({ id: 'one', folderId: 'folder-a' }), {
    folderName: 'Work',
  });
  const second = buildCipherDuplicateSignature(loginCipher({ id: 'two', folderId: 'folder-b' }), {
    folderName: 'Personal',
  });

  assert.notEqual(second, first);
});
