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
  /**
   * Vigencia del Certificado de Riesgo Cofianza (CRC), en días.
   *
   * 60 por decisión de Gerencia (Dirección de Riesgo) del 2026-09-03, que
   * resolvió la contradicción entre el Flujo del módulo de estudios §14
   * ("Vigencia del estudio aprobado. 60 días") y la Política de Evaluación
   * V4.1 §8 (90 días para el CRC). Manda el Flujo: 60. Antes eran 30.
   *
   * Gerencia dijo "60 días" sin distinguir entre la vigencia del ESTUDIO y la
   * del CERTIFICADO: en el código esa distinción no existe. La única vigencia
   * en días que hay es esta — `estudios_certificados.fecha_vencimiento`, que
   * certificado.service.ts calcula como emisión + N días. Los `estudios` no
   * tienen fecha de caducidad propia (en el código "estudio vigente" significa
   * "el más reciente del expediente", no "el que aún no caduca"). Si algún día
   * el estudio caduca por su cuenta, ese valor va en su propia clave, no aquí.
   *
   * OJO: este archivo es solo el FALLBACK. El valor efectivo sale de
   * `configuracion_sistema.empresa`, que getCompany() mezcla ENCIMA — por eso
   * el cambio viene acompañado de la migración 20260903000003.
   */
  certificateValidityDays: 60,
} as const;
