// ============================================================
// Perfiles extranjeros — Politica de Evaluacion V4.1, §15
// ------------------------------------------------------------
// Literal:
//
//   "Los solicitantes sin cedula colombiana (extranjeros con visa, pasaporte u
//    otro documento) no tienen acceso automatico al ecosistema de datos del
//    modelo (Datacredito, TransUnion, PILA). El flujo automatico no es
//    aplicable para este perfil."
//
//   "NOTA: Ningun perfil extranjero puede recibir aprobacion automatica en la
//    version 4.0 del modelo, independientemente de los documentos que
//    presente. La aprobacion siempre requiere revision de analista."
//
// La unica senal que tiene el sistema para "sin cedula colombiana" es el
// TIPO DE DOCUMENTO que se consulta. Todo lo que no sea CC es extranjero para
// este efecto. NIT es persona juridica (no aplica el modelo de personas) y
// TI es menor de edad (el servicio es solo para mayores): ninguno de los dos
// puede aprobarse solo tampoco, asi que van por el mismo carril de revision.
//
// Funcion PURA + el motivo para el gestor. NUNCA rechaza: el §15 dice
// "revision manual", no "rechazo" — un CE con score alto es un buen cliente
// que un analista aprueba en dos horas (SLA del §8).
// ============================================================

/** Tipos de documento con los que el modelo puede aprobar en automatico. */
const DOCUMENTOS_NACIONALES: readonly string[] = ['cc'];

/** Etiqueta del §15 por tipo, para que el gestor sepa que fila aplica. */
const ETIQUETA: Record<string, string> = {
  ce: 'cédula de extranjería',
  ppt: 'Permiso por Protección Temporal (PPT)',
  pep: 'Permiso Especial de Permanencia (PEP)',
  pasaporte: 'pasaporte',
  pp: 'pasaporte',
  nit: 'NIT (persona jurídica)',
  ti: 'tarjeta de identidad',
};

export function esPerfilExtranjero(tipoDocumento: string | null | undefined): boolean {
  const t = String(tipoDocumento ?? '').trim().toLowerCase();
  if (!t) return false; // sin dato no se afirma nada: el gate 8.4 ya exige documento
  return !DOCUMENTOS_NACIONALES.includes(t);
}

/**
 * Motivo de revision manual del §15, o null si el documento es colombiano.
 * Se suma a los demas motivos (§14, §16.5, §8) en reglas-duras.ts.
 */
export function motivoRevisionPerfilExtranjero(tipoDocumento: string | null | undefined): string | null {
  if (!esPerfilExtranjero(tipoDocumento)) return null;
  const t = String(tipoDocumento ?? '').trim().toLowerCase();
  const etiqueta = ETIQUETA[t] ?? `otro documento (${t})`;
  return (
    `El solicitante no tiene cédula colombiana (presentó ${etiqueta}): se revisa con extractos bancarios de 6 meses, ` +
    'soportes de ingresos y un documento de identidad vigente.'
  );
}
