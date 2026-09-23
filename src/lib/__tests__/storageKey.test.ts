import { describe, it, expect } from 'vitest';
import { assertStorageKeyPropia } from '@/lib/storageKey';

// Todo vive en un solo bucket: confirmar una clave ajena devolvía la URL firmada
// de documentos legales o contratos de otra inmobiliaria.
describe('assertStorageKeyPropia', () => {
  const P = 'expedientes/e1/documents/';
  it('acepta la clave que emitió el presigned de ese recurso', () => {
    expect(() => assertStorageKeyPropia(`${P}1700000000_cedula.pdf`, P)).not.toThrow();
  });
  it.each([
    'documentos-legales/otro/rut.pdf',
    'expedientes/e2/documents/x.pdf',
    `${P}../../documentos-legales/otro/rut.pdf`,
    `${P}`,
    `${P}/x.pdf`,
    `${P}a\\b.pdf`,
  ])('rechaza %j con 400 STORAGE_KEY_INVALIDA', (k) => {
    expect(() => assertStorageKeyPropia(k, P)).toThrow(expect.objectContaining({ errorCode: 'STORAGE_KEY_INVALIDA' }));
  });
});
