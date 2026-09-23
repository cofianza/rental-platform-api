import { AppError } from '@/lib/errors';

/**
 * El storage_key que confirma el cliente tiene que ser uno que emitió nuestro
 * presigned para ESE recurso. Todo vive en el mismo bucket (también documentos
 * legales y contratos de otras inmobiliarias) y el API lee con service_role:
 * confirmar una clave ajena registraba el puntero y devolvía su URL firmada.
 */
export function assertStorageKeyPropia(key: string, prefijo: string): void {
  if (
    !key.startsWith(prefijo) ||
    key.length === prefijo.length ||
    key.includes('..') ||
    key.includes('//') ||
    key.includes('\\')
  ) {
    throw AppError.badRequest('La ruta del archivo no corresponde a esta subida.', 'STORAGE_KEY_INVALIDA');
  }
}
