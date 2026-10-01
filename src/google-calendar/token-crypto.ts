import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

/**
 * Cifra tokens OAuth em repouso (AES-256-GCM). Formato: `v1.<iv>.<tag>.<cifra>` em
 * base64url — o prefixo de versão permite trocar algoritmo/chave sem migração às cegas.
 * A chave vem de `GOOGLE_TOKEN_ENC_KEY` (32 bytes em base64).
 */
export class TokenCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key ?? '', 'base64');
    if (key.length !== 32) {
      throw new Error('GOOGLE_TOKEN_ENC_KEY deve ter 32 bytes em base64');
    }
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv, tag, enc].map((p) => (typeof p === 'string' ? p : b64(p))).join('.');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, enc] = payload.split('.');
    if (version !== VERSION || !iv || !tag || enc === undefined) {
      throw new Error('Token cifrado em formato desconhecido');
    }
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(enc, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

function b64(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Hash para segredos que só precisam ser comparados (token do canal de webhook). */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
