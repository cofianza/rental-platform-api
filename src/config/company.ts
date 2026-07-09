/**
 * Datos de COFIANZA S.A.S. usados como FALLBACK por getCompany()
 * (src/lib/companyConfig.ts). Los valores efectivos vienen de
 * `configuracion_sistema.empresa` (editables por admin), que se mezclan ENCIMA
 * de estos defaults — así que cambiar este archivo NO basta si la fila existe.
 *
 * Alimentan: certificados de estudio (certificado.service.ts) y el firmante
 * "Cofianza" de la firma multi-parte (firma-multiparte.service.ts).
 *
 * NIT, correo y dirección confirmados por el cliente el 09-jul-2026 con la
 * Política de Tratamiento de Datos Personales v1.0. El NIT coincide con el que
 * la plantilla del contrato V4 ya trae hardcodeado (902.038.122-7).
 */
export const COMPANY = {
  name: 'Cofianza S.A.S.',
  nit: '902.038.122-7',
  address: 'Calle 75ab sur 52d 336',
  phone: '+573169724813',
  email: 'hola@cofianza.co',
  website: 'www.cofianza.co',
  certificateValidityDays: 30,
} as const;
