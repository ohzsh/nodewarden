import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCipherImportPayload } from '../webapp/src/lib/api/vault';
import { normalizeBitwardenImport } from '../webapp/src/lib/import-formats-bitwarden';
import type { SessionState, VaultDraft } from '../webapp/src/lib/types';

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return btoa(out);
}

const session: SessionState = {
  email: 'import@example.invalid',
  accessToken: 'token',
  symEncKey: bytesToBase64(new Uint8Array(32).fill(1)),
  symMacKey: bytesToBase64(new Uint8Array(32).fill(2)),
};

test('Bitwarden JSON import keeps empty-uri and normal login items', () => {
  const payload = normalizeBitwardenImport({
    encrypted: false,
    items: [
      {
        type: 1,
        name: '宝塔ftp',
        id: '6e9892f2-29ef-4440-bd7d-fb5563e2afc3',
        login: {
          uris: [],
          username: 'example-empty-uri-user',
          password: 'example-empty-uri-password',
        },
        passwordHistory: [],
        creationDate: '2025-01-07T09:01:05.994Z',
        revisionDate: '2025-01-07T09:01:05.995Z',
      },
      {
        type: 1,
        name: 'login.example.com',
        id: 'f8d17b80-cb5b-4302-9da2-36dded741e37',
        login: {
          uris: [
            {
              uri: 'https://login.example.com/login/pwd?redirect_url=https%3A%2F%2Fapp.example.com%2F&source_type=1',
            },
          ],
          username: 'example-uri-user',
          password: 'example-uri-password',
        },
        passwordHistory: [],
        creationDate: '2025-01-07T09:01:06.040Z',
        revisionDate: '2025-01-07T09:01:06.041Z',
      },
    ],
  });

  assert.equal(payload.ciphers.length, 2);
  assert.deepEqual((payload.ciphers[0].login as any).uris, []);
  assert.equal((payload.ciphers[1].login as any).uris[0].uri, 'https://login.example.com/login/pwd?redirect_url=https%3A%2F%2Fapp.example.com%2F&source_type=1');
  assert.equal(payload.ciphers[0].creationDate, '2025-01-07T09:01:05.994Z');
  assert.equal(payload.ciphers[1].revisionDate, '2025-01-07T09:01:06.041Z');
});

test('plain Bitwarden import encryption preserves password history', async () => {
  const draft = {
    type: 1,
    favorite: false,
    name: 'with history',
    folderId: '',
    notes: '',
    reprompt: false,
    loginUsername: 'user',
    loginPassword: 'current',
    loginTotp: '',
    loginUris: [],
    loginFido2Credentials: [],
    cardholderName: '',
    cardNumber: '',
    cardBrand: '',
    cardExpMonth: '',
    cardExpYear: '',
    cardCode: '',
    identTitle: '',
    identFirstName: '',
    identMiddleName: '',
    identLastName: '',
    identUsername: '',
    identCompany: '',
    identSsn: '',
    identPassportNumber: '',
    identLicenseNumber: '',
    identEmail: '',
    identPhone: '',
    identAddress1: '',
    identAddress2: '',
    identAddress3: '',
    identCity: '',
    identState: '',
    identPostalCode: '',
    identCountry: '',
    sshPrivateKey: '',
    sshPublicKey: '',
    sshFingerprint: '',
    customFields: [],
    importPasswordHistory: [
      {
        password: 'old-password',
        lastUsedDate: '2025-01-01T00:00:00.000Z',
      },
    ],
  } as VaultDraft & { importPasswordHistory: Array<{ password: string; lastUsedDate: string }> };

  const payload = await buildCipherImportPayload(session, draft);
  const history = payload.passwordHistory as Array<{ password?: string; lastUsedDate?: string }> | null;
  assert.equal(history?.length, 1);
  assert.match(String(history?.[0]?.password), /^\d+\./);
  assert.equal(history?.[0]?.lastUsedDate, '2025-01-01T00:00:00.000Z');
});
