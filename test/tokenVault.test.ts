import { describe, it, expect } from 'vitest';
import { open, openUtf8, seal } from '../src/crypto/tokenVault.js';

describe('tokenVault', () => {
  it('round-trips utf-8 plaintext', () => {
    const sealed = seal('hello world', 'test:1');
    expect(openUtf8(sealed, 'test:1')).toBe('hello world');
  });

  it('produces a fresh IV for each seal (probabilistic check)', () => {
    const a = seal('same-text', 'test:1');
    const b = seal('same-text', 'test:1');
    expect(Buffer.compare(a.iv, b.iv)).not.toBe(0);
    expect(Buffer.compare(a.ct, b.ct)).not.toBe(0);
  });

  it('rejects decryption with the wrong AAD', () => {
    const sealed = seal('secret', 'token:1');
    expect(() => open(sealed, 'token:2')).toThrow();
  });

  it('rejects ciphertext tampering', () => {
    const sealed = seal('secret', 'test:1');
    const tampered = { ...sealed, ct: Buffer.concat([sealed.ct, Buffer.from([0x00])]) };
    expect(() => open(tampered, 'test:1')).toThrow();
  });

  it('rejects auth tag tampering', () => {
    const sealed = seal('secret', 'test:1');
    const tag = Buffer.from(sealed.tag);
    tag[0] = tag[0]! ^ 0x01;
    expect(() => open({ ...sealed, tag }, 'test:1')).toThrow();
  });
});
