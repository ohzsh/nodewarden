import type { Cipher } from './types';

interface CipherDuplicateSignatureOptions {
  folderName?: string | null;
}

function valueOrFallback(value: string | null | undefined): string {
  return String(value || '');
}

function folderIdentity(cipher: Cipher, options?: CipherDuplicateSignatureOptions): string | null {
  const folderName = String(options?.folderName || '').trim();
  if (folderName) return folderName;
  return cipher.folderId || null;
}

export function buildCipherDuplicateSignature(cipher: Cipher, options?: CipherDuplicateSignatureOptions): string {
  const normalized = {
    type: Number(cipher.type || 1),
    folder: folderIdentity(cipher, options),
    favorite: !!cipher.favorite,
    reprompt: Number(cipher.reprompt || 0),
    name: valueOrFallback(cipher.decName ?? cipher.name),
    notes: valueOrFallback(cipher.decNotes ?? cipher.notes),
    login: cipher.login
      ? {
          username: valueOrFallback(cipher.login.decUsername ?? cipher.login.username),
          password: valueOrFallback(cipher.login.decPassword ?? cipher.login.password),
          totp: valueOrFallback(cipher.login.decTotp ?? cipher.login.totp),
          uris: (cipher.login.uris || []).map((uri) => ({
            uri: valueOrFallback(uri.decUri ?? uri.uri),
            match: uri.match ?? null,
          })),
          fido2Credentials: (cipher.login.fido2Credentials || []).map((credential) => ({
            creationDate: valueOrFallback(credential.creationDate),
          })),
        }
      : null,
    card: cipher.card
      ? {
          cardholderName: valueOrFallback(cipher.card.decCardholderName ?? cipher.card.cardholderName),
          number: valueOrFallback(cipher.card.decNumber ?? cipher.card.number),
          brand: valueOrFallback(cipher.card.decBrand ?? cipher.card.brand),
          expMonth: valueOrFallback(cipher.card.decExpMonth ?? cipher.card.expMonth),
          expYear: valueOrFallback(cipher.card.decExpYear ?? cipher.card.expYear),
          code: valueOrFallback(cipher.card.decCode ?? cipher.card.code),
        }
      : null,
    identity: cipher.identity
      ? {
          title: valueOrFallback(cipher.identity.decTitle ?? cipher.identity.title),
          firstName: valueOrFallback(cipher.identity.decFirstName ?? cipher.identity.firstName),
          middleName: valueOrFallback(cipher.identity.decMiddleName ?? cipher.identity.middleName),
          lastName: valueOrFallback(cipher.identity.decLastName ?? cipher.identity.lastName),
          username: valueOrFallback(cipher.identity.decUsername ?? cipher.identity.username),
          company: valueOrFallback(cipher.identity.decCompany ?? cipher.identity.company),
          ssn: valueOrFallback(cipher.identity.decSsn ?? cipher.identity.ssn),
          passportNumber: valueOrFallback(cipher.identity.decPassportNumber ?? cipher.identity.passportNumber),
          licenseNumber: valueOrFallback(cipher.identity.decLicenseNumber ?? cipher.identity.licenseNumber),
          email: valueOrFallback(cipher.identity.decEmail ?? cipher.identity.email),
          phone: valueOrFallback(cipher.identity.decPhone ?? cipher.identity.phone),
          address1: valueOrFallback(cipher.identity.decAddress1 ?? cipher.identity.address1),
          address2: valueOrFallback(cipher.identity.decAddress2 ?? cipher.identity.address2),
          address3: valueOrFallback(cipher.identity.decAddress3 ?? cipher.identity.address3),
          city: valueOrFallback(cipher.identity.decCity ?? cipher.identity.city),
          state: valueOrFallback(cipher.identity.decState ?? cipher.identity.state),
          postalCode: valueOrFallback(cipher.identity.decPostalCode ?? cipher.identity.postalCode),
          country: valueOrFallback(cipher.identity.decCountry ?? cipher.identity.country),
        }
      : null,
    sshKey: cipher.sshKey
      ? {
          privateKey: valueOrFallback(cipher.sshKey.decPrivateKey ?? cipher.sshKey.privateKey),
          publicKey: valueOrFallback(cipher.sshKey.decPublicKey ?? cipher.sshKey.publicKey),
          fingerprint: valueOrFallback(cipher.sshKey.decFingerprint ?? cipher.sshKey.keyFingerprint ?? cipher.sshKey.fingerprint),
        }
      : null,
    secureNoteType: cipher.secureNote?.type ?? null,
    fields: (cipher.fields || []).map((field) => ({
      type: field.type ?? null,
      name: valueOrFallback(field.decName ?? field.name),
      value: valueOrFallback(field.decValue ?? field.value),
      linkedId: field.linkedId ?? null,
    })),
    passwordHistory: (cipher.passwordHistory || []).map((entry) => ({
      password: valueOrFallback(entry.password),
      lastUsedDate: valueOrFallback(entry.lastUsedDate),
    })),
  };
  return JSON.stringify(normalized);
}
