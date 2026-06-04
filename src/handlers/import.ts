import { Env, Cipher, Folder, CipherType } from '../types';
import { notifyUserVaultSync } from '../services/notifications';
import { StorageService } from '../services/storage';
import { errorResponse, jsonResponse } from '../utils/response';
import { readActingDeviceIdentifier } from '../utils/device';
import { generateUUID } from '../utils/uuid';
import { LIMITS } from '../config/limits';
import { normalizeCipherLoginForStorage, normalizeCipherSshKeyForCompatibility } from './ciphers';

// Bitwarden client import request format
interface CiphersImportRequest {
  ciphers: Array<{
    id?: string | null;
    type: number;
    name?: string | null;
    notes?: string | null;
    favorite?: boolean;
    reprompt?: number;
    sshKey?: any | null;
    key?: string | null;
    login?: {
      uris?: Array<{ uri: string | null; uriChecksum?: string | null; match?: number | null }> | null;
      username?: string | null;
      password?: string | null;
      totp?: string | null;
      autofillOnPageLoad?: boolean | null;
      uri?: string | null;
      passwordRevisionDate?: string | null;
      [key: string]: any;
    } | null;
    card?: {
      cardholderName?: string | null;
      brand?: string | null;
      number?: string | null;
      expMonth?: string | null;
      expYear?: string | null;
      code?: string | null;
    } | null;
    identity?: {
      title?: string | null;
      firstName?: string | null;
      middleName?: string | null;
      lastName?: string | null;
      address1?: string | null;
      address2?: string | null;
      address3?: string | null;
      city?: string | null;
      state?: string | null;
      postalCode?: string | null;
      country?: string | null;
      company?: string | null;
      email?: string | null;
      phone?: string | null;
      ssn?: string | null;
      username?: string | null;
      passportNumber?: string | null;
      licenseNumber?: string | null;
    } | null;
    secureNote?: { type: number } | null;
    fields?: Array<{
      name?: string | null;
      value?: string | null;
      type: number;
      linkedId?: number | null;
    }> | null;
    passwordHistory?: Array<{
      password: string;
      lastUsedDate: string;
    }> | null;
    [key: string]: any;
  }>;
  folders: Array<{
    id?: string | null;
    name: string;
    creationDate?: string | null;
    revisionDate?: string | null;
  }>;
  folderRelationships: Array<{
    key: number;   // cipher index
    value: number; // folder index
  }>;
}

function readAliasedImportProp<T = unknown>(source: any, aliases: string[]): T | undefined {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key] as T;
    }
  }
  return undefined;
}

function normalizeImportTimestamp(value: unknown, fallback: string | null): string | null {
  if (value == null || value === '') return fallback;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function bytesToUuid(bytes: Uint8Array): string {
  const out = Array.from(bytes.slice(0, 16));
  out[6] = (out[6] & 0x0f) | 0x50;
  out[8] = (out[8] & 0x3f) | 0x80;
  const hex = out.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function deterministicImportId(kind: 'folder' | 'cipher', userId: string, sourceId: string | null): Promise<string> {
  if (!sourceId) return generateUUID();
  const input = `nodewarden:bitwarden-import:${kind}:${userId}:${sourceId}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToUuid(new Uint8Array(digest));
}

// POST /api/ciphers/import - Bitwarden client import endpoint
export async function handleCiphersImport(request: Request, env: Env, userId: string): Promise<Response> {
  const storage = new StorageService(env.DB);
  const url = new URL(request.url);
  const returnCipherMap = url.searchParams.get('returnCipherMap') === '1';

  let importData: CiphersImportRequest;
  try {
    importData = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400);
  }

  const folders = importData.folders || [];
  const ciphers = importData.ciphers || [];
  const folderRelationships = importData.folderRelationships || [];

  if (folders.length + ciphers.length > LIMITS.performance.importItemLimit) {
    return errorResponse(`Import exceeds maximum of ${LIMITS.performance.importItemLimit} items`, 400);
  }

  const now = new Date().toISOString();

  // Create folders and build index -> id mapping
  const folderIdMap = new Map<number, string>();
  const folderRows: Folder[] = [];
  
  for (let i = 0; i < folders.length; i++) {
    const sourceFolderId = String((folders[i] as any)?.id ?? '').trim() || null;
    const folderId = await deterministicImportId('folder', userId, sourceFolderId);
    folderIdMap.set(i, folderId);
    const createdAt = normalizeImportTimestamp((folders[i] as any)?.creationDate, now) || now;
    const updatedAt = normalizeImportTimestamp((folders[i] as any)?.revisionDate, createdAt) || createdAt;

    const folder: Folder = {
      id: folderId,
      userId: userId,
      name: folders[i].name,
      createdAt,
      updatedAt,
    };

    folderRows.push(folder);
  }

  // Build cipher index -> folder id mapping from relationships
  const cipherFolderMap = new Map<number, string>();
  for (const rel of folderRelationships) {
    const folderId = folderIdMap.get(rel.value);
    if (folderId) {
      cipherFolderMap.set(rel.key, folderId);
    }
  }

  // Create ciphers
  const cipherRows: Cipher[] = [];
  const cipherMapRows: Array<{ index: number; sourceId: string | null; id: string }> = [];
  for (let i = 0; i < ciphers.length; i++) {
    const c = ciphers[i];
    const folderId = cipherFolderMap.get(i) || readAliasedImportProp<string | null>(c, ['folderId', 'FolderId']) || null;
    const sourceIdRaw = String(c?.id ?? '').trim();
    const sourceId = sourceIdRaw || null;
    const login = readAliasedImportProp<any | null>(c, ['login', 'Login']);
    const card = readAliasedImportProp<any | null>(c, ['card', 'Card']);
    const identity = readAliasedImportProp<any | null>(c, ['identity', 'Identity']);
    const secureNote = readAliasedImportProp<any | null>(c, ['secureNote', 'SecureNote']);
    const fields = readAliasedImportProp<any[] | null>(c, ['fields', 'Fields']);
    const passwordHistory = readAliasedImportProp<any[] | null>(c, ['passwordHistory', 'PasswordHistory']);
    const key = readAliasedImportProp<string | null>(c, ['key', 'Key']);

    const cipherId = await deterministicImportId('cipher', userId, sourceId);
    const createdAt = normalizeImportTimestamp(
      readAliasedImportProp(c, ['createdAt', 'creationDate', 'CreationDate']),
      now
    ) || now;
    const updatedAt = normalizeImportTimestamp(
      readAliasedImportProp(c, ['updatedAt', 'revisionDate', 'RevisionDate']),
      createdAt
    ) || createdAt;
    const deletedAt = normalizeImportTimestamp(
      readAliasedImportProp(c, ['deletedAt', 'deletedDate', 'DeletedDate']),
      null
    );
    const archivedAt = normalizeImportTimestamp(
      readAliasedImportProp(c, ['archivedAt', 'archivedDate', 'ArchivedDate']),
      null
    );

    const cipher: Cipher = {
      ...c,
      id: cipherId,
      userId: userId,
      type: c.type as CipherType,
      folderId: folderId,
      name: c.name ?? 'Untitled',
      notes: c.notes ?? null,
      favorite: c.favorite ?? false,
      login: login ? {
        ...login,
        username: login.username ?? null,
        password: login.password ?? null,
        uris: login.uris?.map((u: any) => ({
          ...u,
          uri: u.uri ?? null,
          uriChecksum: u.uriChecksum ?? null,
          match: u.match ?? null,
        })) || null,
        totp: login.totp ?? null,
        autofillOnPageLoad: login.autofillOnPageLoad ?? null,
        fido2Credentials: Array.isArray(login.fido2Credentials) ? login.fido2Credentials : null,
        uri: login.uri ?? null,
        passwordRevisionDate: login.passwordRevisionDate ?? null,
      } : null,
      card: card ? {
        ...card,
        cardholderName: card.cardholderName ?? null,
        brand: card.brand ?? null,
        number: card.number ?? null,
        expMonth: card.expMonth ?? null,
        expYear: card.expYear ?? null,
        code: card.code ?? null,
      } : null,
      identity: identity ? {
        ...identity,
        title: identity.title ?? null,
        firstName: identity.firstName ?? null,
        middleName: identity.middleName ?? null,
        lastName: identity.lastName ?? null,
        address1: identity.address1 ?? null,
        address2: identity.address2 ?? null,
        address3: identity.address3 ?? null,
        city: identity.city ?? null,
        state: identity.state ?? null,
        postalCode: identity.postalCode ?? null,
        country: identity.country ?? null,
        company: identity.company ?? null,
        email: identity.email ?? null,
        phone: identity.phone ?? null,
        ssn: identity.ssn ?? null,
        username: identity.username ?? null,
        passportNumber: identity.passportNumber ?? null,
        licenseNumber: identity.licenseNumber ?? null,
      } : null,
      secureNote: secureNote ?? null,
      fields: fields?.map((f: any) => ({
        ...f,
        name: f.name ?? null,
        value: f.value ?? null,
        type: f.type,
        linkedId: f.linkedId ?? null,
      })) || null,
      passwordHistory: passwordHistory ?? null,
      reprompt: c.reprompt ?? 0,
      sshKey: normalizeCipherSshKeyForCompatibility((c as any).sshKey ?? null),
      key: key ?? null,
      createdAt,
      updatedAt,
      archivedAt,
      deletedAt,
    };
    cipher.login = normalizeCipherLoginForStorage(cipher.login);

    cipherRows.push(cipher);
    cipherMapRows.push({ index: i, sourceId, id: cipher.id });
  }

  const revisionDate = await storage.importVaultData(folderRows, cipherRows, userId);
  notifyUserVaultSync(env, userId, revisionDate, readActingDeviceIdentifier(request));

  if (returnCipherMap) {
    return jsonResponse({
      object: 'import-result',
      cipherMap: cipherMapRows,
    });
  }

  return new Response(null, { status: 200 });
}
