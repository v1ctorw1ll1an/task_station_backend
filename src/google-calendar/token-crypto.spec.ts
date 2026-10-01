import { randomBytes } from 'crypto';
import { TokenCipher, sha256 } from './token-crypto';

describe('TokenCipher (google-calendar)', () => {
  const key = randomBytes(32).toString('base64');

  it('cifra e decifra ida e volta', () => {
    const c = new TokenCipher(key);
    const enc = c.encrypt('1//refresh-token');
    expect(enc).not.toContain('refresh');
    expect(c.decrypt(enc)).toBe('1//refresh-token');
  });

  it('gera IV novo a cada cifragem', () => {
    const c = new TokenCipher(key);
    expect(c.encrypt('x')).not.toBe(c.encrypt('x'));
  });

  it('recusa payload adulterado (tag GCM)', () => {
    const c = new TokenCipher(key);
    const [v, iv, tag, enc] = c.encrypt('segredo').split('.');
    const flipped = Buffer.from(enc, 'base64url');
    flipped[0] ^= 0xff;
    expect(() => c.decrypt([v, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
  });

  it('recusa outra chave', () => {
    const enc = new TokenCipher(key).encrypt('segredo');
    const other = new TokenCipher(randomBytes(32).toString('base64'));
    expect(() => other.decrypt(enc)).toThrow();
  });

  it('exige chave de 32 bytes', () => {
    expect(() => new TokenCipher(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => new TokenCipher('')).toThrow();
  });

  it('sha256 é determinístico', () => {
    expect(sha256('a')).toBe(sha256('a'));
    expect(sha256('a')).not.toBe(sha256('b'));
  });
});
