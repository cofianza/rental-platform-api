/**
 * Contratos V3 — reglas del asistente de vivienda (Entrega 3, diseño §5.2-§5.4 y §5.7).
 *
 * Puro: sin Supabase ni reloj. asistente.service carga las Fuentes (fail-closed)
 * y pasa `hoy` (AAAA-MM-DD en Bogotá); aquí solo se decide. El orden de los
 * bloqueos es el orden en que la web los pinta.
 */

import type { Calibracion } from '@/lib/calibracion';
import { sumarDiasHabiles } from '@/lib/diasHabiles';
import { destinacionParaContrato, topeCanonPara } from '@/modules/inmuebles/destinacion';
import {
  canonMaximoTolerado,
  evaluarPortabilidad,
  relacionCanonIngresoPct,
  type MotivoNoPortable,
  type VeredictoCanonIngreso,
} from '@/modules/estudios/portabilidad';
import type { Tarifas } from '@/modules/estudios/tarifas';
import { formatearCOP } from '@/modules/estudios/tope-canon.guard';
import { validateNitModulo11 } from '@/modules/registration/registration.schema';
import type {
  AceptacionClausulas,
  Bloqueo,
  EstadoAsistente,
  NumeroPaso,
  Paso1,
  Paso2,
  Paso3,
  Paso4,
  Paso5,
} from './asistente.types';
import { AVISO_VERSION, categoriaClausula, huella, requiereAceptacion, validarClausula } from './clausulas.reglas';
import { fechaBogota } from './formato';
import { MARCADOR } from './motor';
import type { DatosVivienda, Persona } from './vivienda';

// ── Fuentes (lo que el service leyó; nombres de columna tal cual) ──

export interface PerfilArrendador {
  razon_social: string | null;
  nit: string | null;
  representante_legal: string | null;
  representante_legal_tipo_documento: string | null;
  representante_legal_documento: string | null;
  matricula_arrendador: string | null;
  matricula_expedida_por: string | null;
  domicilio_direccion: string | null;
  domicilio_ciudad: string | null;
  email_recaudo: string | null;
  whatsapp_recaudo: string | null;
  logo_storage_key: string | null;
  cuenta_recaudo_banco: string | null;
  cuenta_recaudo_tipo: string | null;
  cuenta_recaudo_numero: string | null;
  cuenta_recaudo_titular_nombre: string | null;
  cuenta_recaudo_titular_nit: string | null;
}

/** Lo que guarda cada paso del asistente en datos_variables.asistente. */
export interface Asistente {
  paso1?: Paso1;
  paso2?: Paso2;
  paso3?: Paso3;
  paso4?: Paso4;
  paso5?: Paso5;
  actualizadoEn?: string;
  /** Un administrador autorizó ESTE conjunto de adicionales (huella) por encima del máximo (D6). */
  excesoAutorizado?: { huella: string; cantidad: number; usuarioId: string; en: string };
}
export type AsistenteCompleto = Required<Omit<Asistente, 'actualizadoEn' | 'excesoAutorizado'>>;

/** datos_variables.documento: la última vista previa y su snapshot (§5.8). */
export interface DocumentoV3 {
  generacion: number;
  generadoEn: string;
  plantillaVersion: string;
  pendientes: string[];
  avisos: string[];
  entrada: DatosVivienda;
  logoStorageKey: string | null;
  fijos: { diaPago: 1; puntosIpc: 0; servicios: 'arrendatario_todos' };
  snapshot: Record<string, unknown>;
  /** Las adicionales impresas (Entrega 4): su huella, la aceptación (null = solo modelos) y el número de la primera. */
  adicionales: { huella: string; aceptacion: AceptacionClausulas | null; primera: number } | null;
  /**
   * El PDF que se envió a firma (Entrega 5): se escribe en el mismo UPDATE que
   * saca la fila de borrador, así que queda congelado con ella.
   */
  final?: {
    ruta: 'A' | 'B';
    sha256: string;
    bytes: number;
    /** Páginas de cada pieza del PDF unido, en orden: [contrato|propio, (anexo), crc]. */
    paginas: number[];
    crcKey: string;
    propioKey: string | null;
    fechaDocumento: string;
  };
}

/** datos_variables.propio: el contrato de la inmobiliaria en la Ruta B (§4.5). */
export interface PropioGuardado {
  key: string;
  nombre: string;
  paginas: number;
  bytes: number;
  sha256: string;
  subidoEn: string;
  subidoPor: string;
}

export interface ContratoV3 {
  id: string;
  estado: string;
  numero: string;
  /** «Iniciar contrato»: desde aquí corre la reserva del inmueble (reservaHasta). */
  created_at: string;
  updated_at: string;
  datos_variables: { asistente?: Asistente; documento?: DocumentoV3; propio?: PropioGuardado } | null;
  storage_key: string | null;
}

export interface Fuentes {
  expediente: {
    id: string;
    numero: string;
    estado: string;
    duracion_contrato_meses: number | null;
    fecha_inicio_contrato: string | null;
  };
  inmueble: {
    id: string;
    codigo: string | null;
    direccion: string;
    ciudad: string;
    uso: string | null;
    estado: string;
    reservado_por_expediente_id: string | null;
    inmobiliaria_id: string;
    valorArriendoCop: number;
    propiedad_horizontal: boolean | null;
    parqueadero: boolean | null;
    cuarto_util: boolean | null;
    // §1.4: lo que el asistente confirma vuelve al registro del inmueble (migración 20260928000001).
    nombre_copropiedad: string | null;
    parqueadero_numero: string | null;
    parqueadero_moto: boolean | null;
    parqueadero_moto_numero: string | null;
    cuarto_util_numero: string | null;
    /** inmuebles.administracion; null si no hay (o no es > 0). */
    administracionCop: number | null;
  };
  solicitante: {
    nombre: string;
    apellido: string;
    tipo_documento: string;
    numero_documento: string;
    tipo_persona: string;
    email: string | null;
    telefono: string | null;
    direccion: string | null;
    ciudad: string | null;
  };
  /** Estudio individual completado más reciente del titular; null si no hay. */
  estudio: {
    id: string;
    resultado: string | null;
    fecha_completado: string | null;
    /** estudios.canon_evaluado; null si no se registró (o no es > 0). */
    canonEvaluadoCop: number | null;
  } | null;
  crc: {
    id: string;
    codigo: string;
    version: number;
    fecha_emision: string;
    fecha_vencimiento: string;
    pdf_storage_key: string | null;
  } | null;
  tarifas: Tarifas | null;
  /** ingreso_inferido_ajustado_cop (Adenda 1 §1.1). Casi siempre null (TransUnion no lo da). */
  ingresoAjustadoCop: number | null;
  coarrendatario: {
    id: string;
    nombre: string;
    apellido: string;
    tipo_documento: string;
    numero_documento: string;
    email: string;
    telefono: string | null;
    estado: string;
    estudio_id: string | null;
    /** Los da el coarrendatario al aceptar la invitación (§8.7.2); null en las anteriores. */
    direccion: string | null;
    municipio: string | null;
    estudio: { estado: string; resultado: string | null } | null;
  } | null;
  arrendador: PerfilArrendador;
  /** §7.2: modalidad que fija el convenio de la inmobiliaria (la administra Cofianza); null = no fija. */
  modalidadFianzaDefecto: Paso1['modalidad'] | null;
  /** Etiquetas de checkPerfilCompletitud (perfil canónico de la inmobiliaria). */
  completitudFaltantes: string[];
  /** Contratos legacy (destinacion NULL) vivos en el estudio: G6. */
  legacyVivos: number;
  /** La fila V3 viva del estudio (una sola, índice contratos_v3_vivo_uq). */
  v3: ContratoV3 | null;
  /**
   * Los pasos del último contrato V3 cancelado del estudio: precargan el siguiente
   * borrador, para que corregir un dato (p. ej. un celular que Auco no acepta) no
   * obligue a llenar los cinco pasos otra vez. null si no hubo.
   */
  anterior: Asistente | null;
  /**
   * Adenda 1 contratos §2.4, con el canon pactado sobre el tope: 'enviado' = el caso
   * está en la Gerencia General; 'fallido' = se intentó y no se registró; ausente =
   * nadie ha intentado generar ni enviar con ese canon. Lo pone el service.
   */
  topeEscalado?: 'enviado' | 'fallido';
}

// ── Helpers ──

const FAVORABLES = ['aprobado', 'condicionado'];
// El Word dice "treinta por ciento (30%)" en letras (vivienda.ts): otro no se imprime.
const CASHBACK_DEL_CONTRATO = 30;
const vacio = (s: string | null | undefined) => !s || !s.trim();
const nombreCompleto = (p: { nombre: string; apellido: string }) =>
  `${p.nombre.trim()} ${p.apellido.trim()}`.trim();
const pctTexto = (n: number, decimales = 2) =>
  n.toLocaleString('es-CO', { maximumFractionDigits: decimales });
const ddmmaaaa = (iso: string) => iso.split('-').reverse().join('/');
const utc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

/** Días calendario de a hasta b (AAAA-MM-DD, sin hora). */
export const diasCalendario = (a: string, b: string) => (utc(b) - utc(a)) / 86_400_000;

/** iso + n días calendario. */
export const masDias = (iso: string, n: number) =>
  new Date(utc(iso) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Adenda 1 contratos (respuesta 15, §5.6): último día (AAAA-MM-DD, Bogotá) de la
 * reserva del inmueble de un borrador iniciado en `creadoEn`, `dias` hábiles
 * después sin contar ese día. Si al día siguiente no se envió a firma, se cancela.
 */
export const reservaHasta = (creadoEn: string, dias: number) => sumarDiasHabiles(fechaBogota(creadoEn), dias);

/** Porcentaje con a lo sumo dos decimales (lo único que el contrato sabe imprimir). */
export const dosDecimales = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9;

/**
 * ¿Rompe el contrato este texto? Marcadores del motor, caracteres de control,
 * más de 300 caracteres o, sin coarrendatario, la palabra "coarrendatario"
 * (el motor en modo final falla con eso: mejor atajarlo en el dato).
 */
export const noImprimible = (s: string, sinCoarrendatario: boolean) =>
  MARCADOR.test(s) ||
  /\p{Cc}/u.test(s) ||
  s.length > 300 ||
  (sinCoarrendatario && /coarrendatari/i.test(s));

/** "900.123.456-8" → { numero: '900123456', dv: '8' }; null si no trae un DV válido (módulo 11). */
export function partirNit(nit: string | null | undefined): { numero: string; dv: string } | null {
  const s = (nit ?? '').replace(/[.\s]/g, '');
  const m = /^(\d{1,15})-(\d)$/.exec(s);
  return m && validateNitModulo11(s) ? { numero: m[1], dv: m[2] } : null;
}

const mismoDocumento = (
  a: { tipo_documento: string; numero_documento: string },
  b: { tipo_documento: string; numero_documento: string },
) => {
  const n = (s: string) => s.replace(/[.\s-]/g, '').toUpperCase();
  return a.tipo_documento === b.tipo_documento && n(a.numero_documento) === n(b.numero_documento);
};

// ── §5.2 Bloqueos ──

/** Todo lo que impide iniciar o generar el contrato, salvo el canon pactado (evaluarCanon). */
export function evaluarBloqueos(f: Fuentes, hoy: string, cal: Calibracion): Bloqueo[] {
  const out: Bloqueo[] = [];
  const b = (codigo: string, mensaje: string, extra?: Omit<Bloqueo, 'codigo' | 'mensaje'>) =>
    out.push({ codigo, mensaje, ...extra });
  const { expediente: exp, inmueble: inm, estudio: est, crc, tarifas: t, solicitante: sol, coarrendatario: coa } = f;

  if (exp.estado !== 'aprobado')
    b('EXPEDIENTE_NO_APROBADO', 'El contrato solo se crea sobre un estudio aprobado.');
  try {
    destinacionParaContrato(inm.uso);
  } catch (e) {
    b('DESTINACION_NO_HABILITADA', (e as Error).message);
  }
  // Reservado por el contrato de otro estudio: se libera si ese contrato se cancela.
  if (inm.estado === 'ocupado' && inm.reservado_por_expediente_id && inm.reservado_por_expediente_id !== exp.id)
    b(
      'INMUEBLE_RESERVADO',
      'El inmueble está reservado para el contrato de otro estudio. Si ese contrato se cancela, el inmueble vuelve a quedar disponible y podrás crear este.',
    );
  // Un 'ocupado' sin titular está arrendado por fuera del flujo.
  if (inm.estado === 'ocupado' && !inm.reservado_por_expediente_id)
    b(
      'INMUEBLE_OCUPADO',
      'El inmueble figura como arrendado. Los inmuebles ya arrendados se incorporan por migración de cartera, que todavía no está disponible: escríbenos para revisar el caso.',
    );
  if (inm.estado === 'inactivo')
    b('INMUEBLE_INACTIVO', 'El inmueble está inactivo. Actívalo antes de crear el contrato.', {
      accion: 'inmueble',
    });
  if (f.legacyVivos > 0)
    b(
      'CONTRATO_YA_EXISTE',
      'Este estudio ya tiene un contrato creado con el flujo anterior. Cancélalo en la pestaña Contratos para usar el asistente.',
    );
  if (!est || !FAVORABLES.includes(est.resultado ?? ''))
    b(
      'EVALUACION_NO_DISPONIBLE',
      'El estudio no tiene una evaluación crediticia completada con resultado favorable.',
    );

  if (est) {
    // A4: día 60 pasa, día 61 bloquea; sin fecha no hay cómo verificar (fail-closed).
    if (!est.fecha_completado) {
      b(
        'ESTUDIO_VENCIDO',
        'La evaluación no tiene fecha de completado y no se puede verificar su vigencia. Se requiere nueva evaluación.',
        { accion: 'estudio' },
      );
    } else {
      const completado = fechaBogota(est.fecha_completado);
      if (diasCalendario(completado, hoy) > cal.VIGENCIA_CRC_DIAS)
        b(
          'ESTUDIO_VENCIDO',
          `La evaluación se completó el ${ddmmaaaa(completado)} y ya tiene más de ${cal.VIGENCIA_CRC_DIAS} días calendario. Se requiere nueva evaluación.`,
          { accion: 'estudio' },
        );
    }
    if (!crc)
      b(
        'CRC_NO_EMITIDO',
        'La evaluación no tiene Certificado de Riesgo (CRC) emitido. Emítelo desde el estudio.',
        { accion: 'estudio' },
      );
  }

  const autorizadoEn = t?.override?.autorizado_en;
  if (crc && autorizadoEn && Date.parse(autorizadoEn) > Date.parse(crc.fecha_emision))
    b(
      'CRC_DESACTUALIZADO',
      'La tarifa negociada se autorizó después de emitir el CRC y el certificado no la refleja. Regenera el CRC desde el estudio.',
      { accion: 'estudio' },
    );
  if (t) {
    if (t.cashback_pct !== CASHBACK_DEL_CONTRATO)
      b(
        'TARIFA_NO_SOPORTADA',
        `La tarifa negociada tiene cashback de ${pctTexto(t.cashback_pct)} % y el contrato de vivienda lo fija en ${CASHBACK_DEL_CONTRATO} %. Escríbenos para revisarla.`,
      );
    if (![t.prima_vinculacion_pct, t.tarifa_mensual_pct, t.cashback_pct].every(dosDecimales))
      b(
        'TARIFA_NO_SOPORTADA',
        'La tarifa tiene porcentajes con más de dos decimales; el contrato no los puede imprimir. Escríbenos para revisarla.',
      );
  }

  // G3: vivienda es para personas naturales mayores de edad (A17, A20).
  const noAdmitido = (tipo: string) => tipo === 'nit' || tipo === 'ti';
  if (sol.tipo_persona === 'juridica' || noAdmitido(sol.tipo_documento))
    b(
      'ARRENDATARIO_NO_ADMITIDO',
      'El contrato de vivienda es para personas naturales mayores de edad identificadas con C.C., C.E. o pasaporte.',
    );
  if (coa) {
    if (coa.estado !== 'estudio_completado' || coa.estudio?.estado !== 'completado')
      b(
        'COARRENDATARIO_SIN_EVALUAR',
        'El coarrendatario vinculado todavía no tiene su evaluación completada. Espera el resultado para crear el contrato.',
      );
    else if (!FAVORABLES.includes(coa.estudio.resultado ?? ''))
      b(
        'COARRENDATARIO_RECHAZADO',
        'La evaluación del coarrendatario no fue favorable, pero el CRC se calculó con coarrendatario. Escríbenos para revisar el caso.',
      );
    if (mismoDocumento(coa, sol) || noAdmitido(coa.tipo_documento))
      b(
        'COARRENDATARIO_NO_ADMITIDO',
        'El coarrendatario debe ser una persona natural mayor de edad, distinta del arrendatario.',
      );
  }

  // G1: lo que el contrato imprime del arrendador y la completitud legacy no pide.
  const p = f.arrendador;
  const faltan = [...f.completitudFaltantes];
  if (vacio(p.matricula_expedida_por)) faltan.push('Matrícula expedida por');
  if (!partirNit(p.nit)) faltan.push('NIT con dígito de verificación válido (ej. 900.123.456-8)');
  if (vacio(p.representante_legal_tipo_documento) || vacio(p.representante_legal_documento))
    faltan.push('Tipo y número de documento del representante legal');
  // Los anchos de contrato_partes (migración 20260921000001) son el límite real: el perfil
  // admite matrícula de 50 caracteres y generar fallaría con 500 al insertar la parte.
  const largo = (v: string | null | undefined) => (v ?? '').trim().length;
  if (largo(p.matricula_arrendador) > 40) faltan.push('Matrícula de arrendador (máximo 40 caracteres)');
  if (largo(p.representante_legal) > 200) faltan.push('Representante legal (máximo 200 caracteres)');
  if (largo(p.matricula_expedida_por) > 150) faltan.push('Matrícula expedida por (máximo 150 caracteres)');
  if (faltan.length)
    b(
      'PERFIL_ARRENDADOR_INCOMPLETO',
      `Faltan datos del arrendador: ${faltan.join(', ')}. El titular de la inmobiliaria los completa en Configuración › Datos para contrato.`,
      { accion: 'datos_contrato', detalle: faltan },
    );

  if (est && est.canonEvaluadoCop === null)
    b(
      'CANON_SIN_EVALUADO',
      'La evaluación no registró el canon con el que se hizo, así que no se puede verificar la tolerancia del canon. Se requiere nueva evaluación.',
      { accion: 'estudio' },
    );

  return out;
}

// ── §5.3 Canon pactado (B2) ──

export interface VeredictoCanon {
  bloqueo: Bloqueo | null;
  /** null cuando bloquea. */
  veredicto: 'igual_o_menor' | 'dentro_tolerancia' | null;
  /** null con igual_o_menor: ahí no se recalcula nada (§2.2 "sin restricción"). */
  canonIngreso: VeredictoCanonIngreso | null;
  /** Exacto; null sin ingreso. Solo va a la bitácora, nunca a la web. */
  canonIngresoPct: number | null;
  topeCop: number;
  toleranciaPct: number;
}

/** Hasta dónde se puede pactar sin nueva evaluación (sin mirar el ingreso, que no se revela). */
export function maximoSinNuevaEvaluacionCop(f: Fuentes, cal: Calibracion): number | null {
  const ev = f.estudio?.canonEvaluadoCop ?? null;
  if (ev === null) return null;
  const tope = topeCanonPara(f.inmueble.uso, cal).topeCop;
  return Math.max(ev, Math.floor(Math.min(canonMaximoTolerado(ev, cal.TOLERANCIA_CANON), tope)));
}

/**
 * Adenda 1 contratos §2.4: cómo termina el bloqueo del tope según el escalamiento
 * (Fuentes.topeEscalado). Solo dice «se envió» si el aviso a la Gerencia quedó registrado.
 */
const TOPE_PENDIENTE =
  ' Pacta un canon dentro del tope; si necesitas este canon, genera la vista previa y el caso pasará a la Gerencia General de Cofianza para evaluar un coafianzamiento.';
const TOPE_SEGUN_ESCALAMIENTO = {
  enviado:
    ' El caso se envió a la Gerencia General de Cofianza para evaluar un coafianzamiento; mientras tanto, puedes pactar un canon dentro del tope.',
  fallido: ' Escríbele a Cofianza para evaluar un coafianzamiento; mientras tanto, puedes pactar un canon dentro del tope.',
};

/** B2 sobre el canon del contrato. null si no hay canon evaluado (CANON_SIN_EVALUADO ya bloquea). */
export function evaluarCanon(f: Fuentes, canonCop: number, cal: Calibracion): VeredictoCanon | null {
  const ev = f.estudio?.canonEvaluadoCop ?? null;
  if (ev === null) return null;
  const base = {
    topeCop: topeCanonPara(f.inmueble.uso, cal).topeCop,
    toleranciaPct: cal.TOLERANCIA_CANON,
    canonIngresoPct: relacionCanonIngresoPct(canonCop, f.ingresoAjustadoCop),
  };
  if (canonCop <= ev) return { ...base, bloqueo: null, veredicto: 'igual_o_menor', canonIngreso: null };

  const v = evaluarPortabilidad({
    canonOriginal: ev,
    ingresoOriginal: f.ingresoAjustadoCop,
    canonDestino: canonCop,
    topeCop: base.topeCop,
    toleranciaPct: base.toleranciaPct,
    canonIngresoMaxPct: cal.TOPE_CANON_INGRESO_RECALCULO,
  });
  if (v.portable)
    return { ...base, bloqueo: null, veredicto: 'dentro_tolerancia', canonIngreso: v.veredictoCanonIngreso };

  const cop = formatearCOP;
  const motivos: Partial<Record<MotivoNoPortable, [string, string]>> = {
    // Adenda 1 contratos §2.4: bloquear y escalar a la Gerencia General (escala el service al generar o enviar).
    excede_tope_canon: [
      'CANON_EXCEDE_TOPE',
      `El canon pactado (${cop(canonCop)}) supera el tope de ${cop(base.topeCop)} que Cofianza afianza para vivienda sin coafianzamiento.${
        f.topeEscalado ? TOPE_SEGUN_ESCALAMIENTO[f.topeEscalado] : TOPE_PENDIENTE
      }`,
    ],
    excede_tolerancia: [
      'CANON_FUERA_DE_TOLERANCIA',
      `El canon pactado (${cop(canonCop)}) supera en más de ${pctTexto(base.toleranciaPct)} % el canon evaluado (${cop(ev)}); el máximo sin nueva evaluación es ${cop(maximoSinNuevaEvaluacionCop(f, cal) ?? ev)}. Se requiere nueva evaluación.`,
    ],
    // Tres decimales: 40,004 % no puede salir "40 %, por encima del 40 %".
    canon_ingreso_excede: [
      'CANON_INGRESO_EXCEDE',
      `Con el canon pactado, la relación canon/ingreso quedaría en ${pctTexto(base.canonIngresoPct ?? 0, 3)} %, por encima del ${pctTexto(cal.TOPE_CANON_INGRESO_RECALCULO)} %. Se requiere nueva evaluación.`,
    ],
  };
  // sin_canon_* no llegan aquí (ev y canonCop > 0); si llegaran, es el mismo caso que B2a.
  const [codigo, mensaje] = motivos[v.motivo] ?? [
    'CANON_SIN_EVALUADO',
    'La evaluación no registró el canon con el que se hizo, así que no se puede verificar la tolerancia del canon. Se requiere nueva evaluación.',
  ];
  return {
    ...base,
    // Por encima del tope una evaluación nueva no sirve: se pacta uno menor o decide la Gerencia.
    bloqueo: { codigo, mensaje, paso: 1, ...(codigo !== 'CANON_EXCEDE_TOPE' && { accion: 'estudio' as const }) },
    veredicto: null,
    canonIngreso: v.veredictoCanonIngreso,
  };
}

/** Antes de guardar el paso 1 el canon del registro solo avisa: aún se puede pactar uno menor. */
export const avisoCanon = (bloqueo: Bloqueo) =>
  bloqueo.codigo === 'CANON_EXCEDE_TOPE'
    ? bloqueo.mensaje.replace(
        TOPE_PENDIENTE,
        ' Puedes pactar un canon menor en el paso 1; si necesitas este canon, al generar la vista previa el caso pasará a la Gerencia General de Cofianza para evaluar un coafianzamiento.',
      )
    : `${bloqueo.mensaje.replace(/ Se requiere nueva evaluación\.$/, '')} Puedes pactar un canon menor en el paso 1; si no, se requerirá nueva evaluación.`;

// ── §5.4 Prefill, faltantes, imprimibles, avisos ──

type Prefill = NonNullable<EstadoAsistente['contrato']>['prefill'];

/**
 * Lo que un borrador nuevo ya trae: los pasos del contrato cancelado del estudio
 * (si hubo) y, debajo, lo que dicen el registro, el estudio y el perfil. Las
 * fechas que ya pasaron no se copian; el coarrendatario, solo si sigue vinculado.
 */
export function prefill(f: Fuentes, hoy: string, cal: Calibracion): Prefill {
  const base = prefillDelRegistro(f, hoy, cal);
  const a = f.anterior;
  if (!a) return base;
  const c5 = a.paso5?.contactos;
  let p3 = base[3];
  if (a.paso3) {
    // Sin PH la cuota se guarda null; en el prefill va ausente.
    const { administracion, fechaInicio, fechaEntrega, ...resto } = a.paso3;
    p3 = {
      ...resto,
      ...(administracion ? { administracion } : {}),
      ...(fechaInicio >= hoy && fechaEntrega >= hoy
        ? { fechaInicio, fechaEntrega }
        : { fechaInicio: base[3].fechaInicio, fechaEntrega: base[3].fechaEntrega }),
    };
  }
  return {
    1: { ...base[1], ...a.paso1 },
    2: a.paso2 ?? base[2],
    3: p3,
    ...(a.paso4 && 'clausulas' in a.paso4
      ? {
          4: {
            clausulas: a.paso4.clausulas.map((c) => ({
              clausulaId: c.clausulaId,
              origen: c.origen, // la web decide con esto si pide la aceptación (resp. 13)
              ...(c.valores ? { valores: c.valores } : {}),
            })),
          },
        }
      : {}),
    5: a.paso5 && c5
      ? {
          ...a.paso5,
          contactos: {
            ...c5,
            coarrendatario: f.coarrendatario ? (c5.coarrendatario ?? base[5].contactos?.coarrendatario ?? null) : null,
          },
        }
      : base[5],
  };
}

/** Solo valores con fuente; lo demás arranca vacío (la comisión nunca se adivina, A12). */
function prefillDelRegistro(f: Fuentes, hoy: string, cal: Calibracion): Prefill {
  const { inmueble: inm, arrendador: p, solicitante: s, coarrendatario: coa } = f;
  const inicio = f.expediente.fecha_inicio_contrato?.slice(0, 10);
  const inicioVigente = inicio && inicio >= hoy ? inicio : null;
  return {
    1: {
      ruta: 'A',
      canonCop: inm.valorArriendoCop,
      // §7.2: preseleccionada y modificable contrato por contrato.
      ...(f.modalidadFianzaDefecto ? { modalidad: f.modalidadFianzaDefecto } : {}),
    },
    2: {
      // '' = sí, falta el número; null = no.
      usos: {
        carro: inm.parqueadero ? (inm.parqueadero_numero ?? '') : null,
        moto: inm.parqueadero_moto ? (inm.parqueadero_moto_numero ?? '') : null,
        util: inm.cuarto_util ? (inm.cuarto_util_numero ?? '') : null,
      },
      ...(inm.propiedad_horizontal !== null && { propiedadHorizontal: inm.propiedad_horizontal }),
      ...(inm.propiedad_horizontal && inm.nombre_copropiedad ? { nombreCopropiedad: inm.nombre_copropiedad } : {}),
    },
    3: {
      vigenciaMeses: f.expediente.duracion_contrato_meses ?? cal.VIGENCIA_MESES_DEFECTO,
      // §8.3.3: la entrega arranca igual a la iniciación.
      ...(inicioVigente ? { fechaInicio: inicioVigente, fechaEntrega: inicioVigente } : {}),
      // §1.3: el valor de la cuota sale del registro; a cargo de quién e incluida, no se adivinan.
      ...(inm.propiedad_horizontal && inm.administracionCop ? { administracion: { valorCop: inm.administracionCop } } : {}),
    },
    5: {
      ...(p.domicilio_ciudad?.trim() ? { ciudadFirma: p.domicilio_ciudad } : {}),
      contactos: {
        arrendador: {
          direccion: p.domicilio_direccion ?? '',
          municipio: p.domicilio_ciudad ?? '',
          email: p.email_recaudo ?? '',
          telefono: p.whatsapp_recaudo ?? '',
        },
        arrendatario: {
          direccion: s.direccion ?? '',
          municipio: s.ciudad ?? '',
          email: s.email ?? '',
          telefono: s.telefono ?? '',
        },
        coarrendatario: coa
          ? {
              direccion: coa.direccion ?? '',
              municipio: coa.municipio ?? '',
              email: coa.email ?? '',
              telefono: coa.telefono ?? '',
            }
          : null,
      },
    },
  };
}

/**
 * §1.4: lo que el paso 2 (o el 3, la cuota) confirma del inmueble y difiere de
 * su registro, listo para escribirse en `inmuebles`; null si no cambia nada.
 */
export function cambiosInmueble(
  inm: Fuentes['inmueble'],
  paso: { paso: 2; datos: Paso2 } | { paso: 3; datos: Paso3 },
): Record<string, string | number | boolean | null> | null {
  let nuevo: Record<string, string | number | boolean | null>;
  if (paso.paso === 2) {
    const { usos, propiedadHorizontal: ph, nombreCopropiedad } = paso.datos;
    nuevo = {
      propiedad_horizontal: ph,
      nombre_copropiedad: ph ? nombreCopropiedad : null,
      parqueadero: usos.carro !== null,
      parqueadero_numero: usos.carro,
      parqueadero_moto: usos.moto !== null,
      parqueadero_moto_numero: usos.moto,
      cuarto_util: usos.util !== null,
      cuarto_util_numero: usos.util,
    };
  } else {
    const adm = paso.datos.administracion;
    // 0 no dice nada de la cuota (p. ej. incluida en el canon): no borra la del registro.
    if (!adm || adm.valorCop <= 0) return null;
    nuevo = { administracion: adm.valorCop };
  }
  const actual: Record<string, unknown> = { ...inm, administracion: inm.administracionCop ?? 0 };
  const cambios = Object.fromEntries(Object.entries(nuevo).filter(([k, v]) => actual[k] !== v));
  return Object.keys(cambios).length ? cambios : null;
}

const PASOS: NumeroPaso[] = [1, 2, 3, 4, 5];

export function faltantes(a: Asistente, f: Fuentes, hoy: string): { paso: NumeroPaso; mensaje: string }[] {
  // Ruta B: no hay cláusulas adicionales (§4.8), el paso 4 no aplica.
  const pasos = a.paso1?.ruta === 'B' ? PASOS.filter((n) => n !== 4) : PASOS;
  const out = pasos.filter((n) => !a[`paso${n}`]).map((paso) => ({
    paso,
    mensaje: 'Falta guardar este paso.',
  }));
  const { paso2, paso3, paso5 } = a;
  if (paso2 && paso3 && paso2.propiedadHorizontal !== (paso3.administracion !== null))
    out.push({
      paso: 3,
      mensaje: 'Con propiedad horizontal completa la cuota de administración; sin ella, quítala.',
    });
  if (paso5 && (f.coarrendatario !== null) !== (paso5.contactos.coarrendatario !== null))
    out.push({ paso: 5, mensaje: 'Revisa los datos de notificación del coarrendatario.' });
  if (paso3 && (paso3.fechaInicio < hoy || paso3.fechaEntrega < hoy))
    out.push({ paso: 3, mensaje: 'La fecha de iniciación o de entrega ya pasó; actualízala.' });
  return out;
}

/**
 * Rutas de los textos de `d` que no se pueden imprimir. Cubre lo que viene del
 * perfil, del solicitante y del inmueble, que ningún schema del asistente valida.
 */
export function noImprimibles(d: DatosVivienda): string[] {
  const sinCoa = d.coarrendatarios.length === 0;
  const rutas: string[] = [];
  const recorrer = (v: unknown, ruta: string) => {
    if (typeof v === 'string') {
      if (noImprimible(v, sinCoa)) rutas.push(ruta);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) recorrer(x, ruta ? `${ruta}.${k}` : k);
    }
  };
  recorrer(d, '');
  return rutas;
}

export const bloqueoNoImprimible = (rutas: string[]): Bloqueo => ({
  codigo: 'DATO_NO_IMPRIMIBLE',
  mensaje: `Estos datos no se pueden imprimir en el contrato: ${rutas.join(', ')}. Corrígelos donde se registran.`,
  detalle: rutas,
});

/** Los textos pendientes de la vista previa (motor en modo revisión), en español. */
export function avisosDePendientes(pendientes: { id: string }[]): string[] {
  const ids = pendientes.map((p) => p.id);
  const avisos: string[] = [];
  // a-… son los del Anexo de la Ruta B.
  const singulares = ids.filter((i) => /^(a-)?c-/.test(i)).length;
  if (singulares)
    avisos.push(
      `Sin coarrendatario: ${singulares} ajustes de redacción en singular pendientes de aprobación.`,
    );
  if (ids.some((i) => /^(a-)?j-/.test(i)))
    avisos.push(
      'Documento distinto de cédula de ciudadanía: su mención en las firmas está pendiente de aprobación.',
    );
  if (ids.length) avisos.push('Mientras haya textos pendientes, el contrato no se puede enviar a firma.');
  return avisos;
}

/**
 * Los textos sin aprobar que el documento va a llevar, previstos con lo guardado
 * (la vista previa los confirma). `sinAprobar` = los ids que el motor marcaría en
 * la plantilla de la ruta (PENDIENTE(x) y borradores sin aprobación): cuando se
 * aprueban, el aviso desaparece solo.
 */
export function textosPendientesPrevistos(f: Fuentes, a: Asistente, sinAprobar: ReadonlySet<string>): string[] {
  const docs = [f.solicitante.tipo_documento, f.coarrendatario?.tipo_documento];
  const ids = [...sinAprobar].filter((id) =>
    /^b-/.test(id)
      ? a.paso1?.modalidad === 'tradicional'
      : /^(a-)?c-/.test(id)
        ? !f.coarrendatario
        : /^(a-)?j-/.test(id)
          ? docs.some((t) => !!t && t !== 'cc')
          : false,
  );
  return avisosDePendientes(ids.map((id) => ({ id })));
}

// ── §5.7 Pasos + fuentes → DatosVivienda ──

const TIPO_CUENTA: Record<string, string> = { ahorros: 'de ahorros', corriente: 'corriente' };

/**
 * Supone los bloqueos resueltos (G1: NIT con DV; G2: CRC; tarifas). Si no lo
 * están, el motor falla con PLANTILLA_DATO_FALTANTE en vez de imprimir basura
 * (sin tarifas van NaN, que validarDatos rechaza: nunca 0 % ni la prima sin IVA).
 */
export function armarDatosVivienda(
  f: Fuentes,
  a: AsistenteCompleto,
  hoy: string,
  numero: string,
): DatosVivienda {
  const { arrendador: p, solicitante: s, coarrendatario: coa, crc } = f;
  const nit = partirNit(p.nit) ?? { numero: '', dv: '' };
  const t = f.tarifas;
  const contactos = a.paso5.contactos;
  return {
    numero,
    ciudadFirma: a.paso5.ciudadFirma,
    fechaDocumento: hoy,
    arrendador: {
      tipoPersona: 'juridica',
      nombre: p.razon_social ?? '',
      tipoDocumento: 'nit',
      numeroDocumento: nit.numero,
      digitoVerificacion: nit.dv,
      representanteLegalNombre: p.representante_legal,
      matriculaNumero: p.matricula_arrendador,
      matriculaExpedidaPor: p.matricula_expedida_por,
      ...contactos.arrendador,
    },
    arrendatario: {
      tipoPersona: s.tipo_persona as Persona['tipoPersona'],
      nombre: nombreCompleto(s),
      tipoDocumento: s.tipo_documento as Persona['tipoDocumento'],
      numeroDocumento: s.numero_documento,
      ...contactos.arrendatario,
    },
    coarrendatarios:
      coa && contactos.coarrendatario
        ? [
            {
              tipoPersona: 'natural',
              nombre: nombreCompleto(coa),
              tipoDocumento: coa.tipo_documento as Persona['tipoDocumento'],
              numeroDocumento: coa.numero_documento,
              ...contactos.coarrendatario,
            },
          ]
        : [],
    inmueble: {
      direccion: f.inmueble.direccion,
      municipio: f.inmueble.ciudad,
      propiedadHorizontal: a.paso2.propiedadHorizontal,
      usos: a.paso2.usos,
    },
    canonCop: a.paso1.canonCop,
    vigenciaMeses: a.paso3.vigenciaMeses,
    fechaInicio: a.paso3.fechaInicio,
    cuenta: {
      tipo: TIPO_CUENTA[p.cuenta_recaudo_tipo ?? ''] ?? p.cuenta_recaudo_tipo ?? '',
      numero: p.cuenta_recaudo_numero ?? '',
      banco: p.cuenta_recaudo_banco ?? '',
      titular: p.cuenta_recaudo_titular_nombre ?? '',
      nit: p.cuenta_recaudo_titular_nit ?? '',
    },
    modalidad: a.paso1.modalidad,
    crc: { numero: crc?.codigo ?? '', fecha: crc ? fechaBogota(crc.fecha_emision) : '' },
    primaPct: t?.prima_vinculacion_pct ?? NaN,
    tarifaPct: t?.tarifa_mensual_pct ?? NaN,
    ivaPct: t?.iva_pct ?? NaN,
    cashbackPct: t?.cashback_pct ?? NaN,
    comisionPct: a.paso3.comisionPct,
    administracion: a.paso3.administracion,
  };
}

// ── Entrega 4: cláusulas adicionales (diseño §5.3) ──

/** Lo que cargarFuentes lee del catálogo para las cláusulas del paso 4. */
export interface FilaCatalogoAdicional {
  id: string;
  inmobiliaria_id: string | null;
  titulo: string;
  texto: string;
  estado: string;
  version: number;
  inhabilitada_motivo: string | null;
}

/**
 * Lo que las adicionales guardadas impiden hoy. Se re-evalúa en GET y en
 * generar: una regla endurecida o una inhabilitación frena los borradores y
 * nunca toca los firmados (su registro está congelado).
 */
export function bloqueosAdicionales(
  a: Asistente,
  catalogo: FilaCatalogoAdicional[],
  o: { maximo: number; sinCoarrendatario: boolean },
): { bloqueos: Bloqueo[]; avisos: string[] } {
  const bloqueos: Bloqueo[] = [];
  const avisos: string[] = [];
  const p4 = a.paso4;
  if (!p4 || !('clausulas' in p4)) return { bloqueos, avisos };
  const b = (codigo: string, mensaje: string, detalle?: string[]) =>
    bloqueos.push({ codigo, mensaje, paso: 4, ...(detalle && { detalle }) });

  for (const c of p4.clausulas) {
    const fila = catalogo.find((x) => x.id === c.clausulaId);
    // Eliminada = ausente: guardar el paso 4 ya la rechaza (prepararPaso4 exige 'activa').
    if (!fila || fila.estado === 'eliminada')
      b('CLAUSULA_INHABILITADA', `La cláusula «${c.titulo}» ya no está disponible. Quítala del contrato para continuar.`);
    else if (fila.estado === 'inhabilitada')
      b(
        'CLAUSULA_INHABILITADA',
        `Cofianza inhabilitó la cláusula «${c.titulo}»: ${fila.inhabilitada_motivo ?? 'sin motivo registrado'}. Quítala del contrato para continuar.`,
      );
    else if (fila.version > c.version)
      avisos.push(`Hay una versión más reciente de «${c.titulo}». Si vuelves a guardar el paso 4, el contrato usará la nueva.`);
    // Resp. 13: un modelo sin cambios es texto de Cofianza y queda fuera de la aceptación. Con la
    // misma versión se vuelve a comparar con el modelo: si ya no coincide, la aceptación no lo cubre.
    else if (c.origen === 'biblioteca' && categoriaClausula(c, fila) !== 'biblioteca')
      b('CLAUSULA_MODELO_ALTERADO', `«${c.titulo}» ya no coincide con el modelo sugerido por Cofianza: vuelve a guardar el paso 4.`);

    const h = validarClausula(c, { destinacion: 'vivienda', sinCoarrendatario: o.sinCoarrendatario }).hallazgos[0];
    if (h) b('CLAUSULA_NO_PERMITIDA', `«${c.titulo}»: ${h.mensaje}`, h.norma ? [h.norma] : undefined);
    // La IA no revisa lo de la inmobiliaria (respuesta 13 bis): sin bloqueo por revisión automática.
  }
  // La aceptación cubre exactamente las propias y los modelos con datos (resp. 13), con el
  // aviso vigente: si el aviso cambia, generar y enviar esperan a que se acepte de nuevo.
  const cubiertas = p4.clausulas.filter(requiereAceptacion);
  if (
    cubiertas.length &&
    (p4.aceptacion?.huella !== huella(cubiertas) || p4.aceptacion?.avisoVersion !== AVISO_VERSION)
  )
    b(
      'ACEPTACION_PENDIENTE',
      'Acepta el aviso de responsabilidad vigente para tus cláusulas propias y los datos que completaste en los modelos: vuelve a guardar el paso 4.',
    );

  const n = p4.clausulas.length;
  if (n > o.maximo && a.excesoAutorizado?.huella !== p4.huella)
    b(
      'ADICIONALES_EXCEDEN_LIMITE',
      `Este contrato tiene ${n} cláusulas adicionales y el máximo es ${o.maximo}. Para incorporar más, Cofianza debe revisarlas: solicita la revisión o reduce el número.`,
    );
  return { bloqueos, avisos };
}
