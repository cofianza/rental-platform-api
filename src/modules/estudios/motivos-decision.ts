// ============================================================
// Motivos codificados de las decisiones manuales (H58/H103, decisión del
// usuario 2026-09-28): el analista ELIGE uno o varios de una lista y puede
// sumar un texto. Cada motivo tiene dos textos:
//   - visible: lo que ve la inmobiliaria / el propietario. Sin umbrales ni
//     puntajes (la Política declara el modelo secreto industrial).
//   - interno: el específico, con la regla de la Política. Solo Cofianza.
// «Otro» exige el texto.
//
// Los textos compuestos llenan los campos que ya existían (motivo_rechazo,
// fundamento, condiciones, comentario), así que el RPC no cambia; el código del
// motivo queda al inicio de cada línea interna. Los códigos además van a la
// columna `motivos_decision` (migración 20261001000018): ver guardarCodigosMotivo.
// ============================================================

import { z } from 'zod';

type Motivo = { visible: string; interno: string };

/** Pendiente de confirmar con Cofianza: por ahora R2, R4 y R5 no se detallan a la inmobiliaria. */
const NO_CUMPLE = 'No cumple la Política de riesgo';

export const MOTIVOS_DECISION = {
  aprobar: {
    A1: { visible: 'Documentos de ingreso verificados', interno: 'Documentos de ingreso verificados (Anexo A)' },
    A2: { visible: 'El coarrendatario compensa el perfil', interno: 'El coarrendatario compensa el perfil (§5)' },
    A3: {
      visible: 'Referencia de arrendamiento anterior verificada',
      interno: 'Referencia de arrendamiento anterior verificada (V9, llamada al arrendador)',
    },
    A4: {
      visible: 'Cumple el carril sin historial crediticio',
      interno:
        'Carril thin-file (§15): fuente de capacidad verificable + coarrendatario con puntaje ≥ 80 + canon ≤ 30 % del ingreso',
    },
    A5: { visible: 'Identidad verificada por el analista', interno: 'Identidad verificada por el analista (biometría no coincidente u omitida)' },
    A6: {
      visible: 'Diferencia entre fuentes aclarada',
      interno: 'Diferencia entre fuentes aclarada (scores con más de 80 puntos, o IBC frente a ingreso inferido)',
    },
    A7: { visible: 'Consulta a centrales repetida con éxito', interno: 'Consulta a centrales repetida con éxito tras una falla técnica (§14)' },
    A8: {
      visible: 'Perfil que requiere revisión manual según la Política, con documentos completos',
      interno:
        'Perfil sin aprobación automática por Política (extranjero, independiente informal o rentista de capital), con documentos completos del Anexo A',
    },
    A9: { visible: 'Otro', interno: 'Otro' },
  },
  rechazar: {
    R1: { visible: 'El historial crediticio no cumple la Política', interno: 'Score externo promedio menor a 450 (regla dura §6)' },
    R2: { visible: NO_CUMPLE, interno: 'Mora vigente, o mora de más de 30 días en los últimos 6 meses (regla dura §6)' },
    R3: {
      visible: 'Capacidad de pago insuficiente',
      interno: 'Endeudamiento (DTI) mayor a 65 % o canon mayor a 40 % del ingreso inferido (regla dura §6)',
    },
    R4: { visible: NO_CUMPLE, interno: 'Proceso de restitución de inmueble vigente o en los últimos 3 años (regla dura §6)' },
    R5: { visible: NO_CUMPLE, interno: 'Reporte en listas restrictivas: OFAC, ONU o Clinton (regla dura §6)' },
    R6: { visible: 'Información inconsistente', interno: 'Inconsistencia documental objetiva, causal taxativa del §7' },
    R7: {
      visible: 'El perfil no alcanza el puntaje mínimo y el coarrendatario no lo compensa',
      interno: 'Puntaje total menor a 70 sin compensación del coarrendatario (§3 y §5)',
    },
    R8: { visible: 'No se aportaron los documentos obligatorios', interno: 'Documentos obligatorios del Anexo A no aportados' },
    R9: { visible: NO_CUMPLE, interno: 'Otro' },
  },
  condicionar: {
    C1: { visible: 'Requiere coarrendatario', interno: 'Requiere coarrendatario con puntaje ≥ 80 (§5)' },
    C2: { visible: 'Requiere documentos de ingreso adicionales', interno: 'Requiere documentos de ingreso adicionales (Anexo A)' },
    C3: { visible: 'Requiere referencia de arrendamiento anterior', interno: 'Requiere referencia de arrendamiento anterior (V9)' },
    C4: { visible: 'Requiere verificar la identidad por otro medio', interno: 'Requiere verificar la identidad por otro medio (Adenda 2 §9)' },
    C5: {
      visible: 'Canon por encima del tope: requiere autorización escrita de la Gerencia General',
      interno: 'Canon por encima del tope transitorio (CANON_MAX_TRANSITORIO): requiere autorización escrita de la Gerencia General',
    },
    C6: { visible: 'Otro', interno: 'Otro' },
  },
} as const satisfies Record<string, Record<string, Motivo>>;

export type TipoDecision = keyof typeof MOTIVOS_DECISION;
const OTRO: Record<TipoDecision, string> = { aprobar: 'A9', rechazar: 'R9', condicionar: 'C6' };

/** Campos que agrega cada body: la lista (códigos) y el texto opcional. */
export const camposMotivos = {
  motivos: z.array(z.string().trim().max(5)).min(1, 'Elija al menos un motivo').max(10).optional(),
  motivo_detalle: z.string().trim().max(1000).optional(),
};

/** Los códigos tienen que ser de la lista de esa decisión, y «Otro» exige el texto. */
export function refinarMotivos(
  tipo: TipoDecision | null,
  d: { motivos?: string[]; motivo_detalle?: string },
  ctx: z.RefinementCtx,
) {
  if (!d.motivos?.length) return;
  const catalogo = tipo ? (MOTIVOS_DECISION[tipo] as Record<string, Motivo>) : {};
  const ajenos = d.motivos.filter((c) => !(c in catalogo));
  if (ajenos.length) {
    ctx.addIssue({ code: 'custom', path: ['motivos'], message: `Motivos no válidos para esta decisión: ${ajenos.join(', ')}` });
  }
  if (tipo && d.motivos.includes(OTRO[tipo]) && (d.motivo_detalle ?? '').length < 10) {
    ctx.addIssue({ code: 'custom', path: ['motivo_detalle'], message: 'Con «Otro», escriba el motivo (mínimo 10 caracteres).' });
  }
}

/**
 * z.preprocess: con `motivos`, llena los campos de texto que ya existían (sin
 * pisar los que vengan escritos), para que el resto del flujo no cambie.
 */
export function rellenarDesdeMotivos(
  tipoDe: (b: Record<string, unknown>) => TipoDecision | null,
  rellenar: (b: Record<string, unknown>, t: { visible: string; interno: string; detalle: string }) => void,
) {
  return (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return raw;
    const b = { ...(raw as Record<string, unknown>) };
    const tipo = tipoDe(b);
    if (!tipo || !Array.isArray(b.motivos) || b.motivos.length === 0) return b;
    const detalle = typeof b.motivo_detalle === 'string' ? b.motivo_detalle.trim() : '';
    rellenar(b, { ...componerMotivos(tipo, b.motivos as string[], detalle), detalle });
    return b;
  };
}

/**
 * Guarda los códigos en la columna `motivos_decision` (migración
 * 20261001000018, aplicada en prod el 2026-09-28). En un UPDATE aparte y sin
 * lanzar: la decisión ya quedó guardada con sus textos y devolver 500 haría
 * creer que no. Si el UPDATE falla (p. ej. se revirtió la 018), logger.error.
 */
export async function guardarCodigosMotivo(
  tabla: 'estudios' | 'eventos_timeline',
  id: string | null | undefined,
  codigos: readonly string[] | undefined,
): Promise<void> {
  if (!id || !codigos?.length) return;
  const { supabase } = await import('@/lib/supabase');
  const { logger } = await import('@/lib/logger');
  const { error } = await (supabase.from(tabla as string) as ReturnType<typeof supabase.from>)
    .update({ motivos_decision: [...codigos] } as never)
    .eq('id', id);
  if (error) logger.error({ tabla, id, codigos, err: error.message }, 'No se guardaron los códigos de motivo de la decisión');
}

/**
 * M4 (revisión 2026-09-28): con `motivos`, el fundamento interno SIEMPRE lleva
 * las líneas de los motivos; si además vino un texto escrito (p. ej. uno que
 * quedó de otra transición en el mismo modal), se agrega al final en vez de
 * reemplazarlas.
 */
export function internoConEscrito(interno: string, escrito: unknown): string {
  const e = typeof escrito === 'string' ? escrito.trim() : '';
  return e && e !== interno ? `${interno}\nTexto adicional: ${e}` : interno;
}

/**
 * Tope de los campos internos armados con motivos: todos los motivos de una
 * decisión + detalle de 1000 + un texto adicional de 1000 caben (M6).
 */
export const MAX_INTERNO = 3000;

/**
 * Textos compuestos. `visible` sin repetir (varios rechazos pueden decir
 * «No cumple la Política de riesgo»); `interno` una línea por motivo con su
 * código, más el texto del analista.
 */
export function componerMotivos(
  tipo: TipoDecision,
  codigos: readonly string[],
  detalle?: string | null,
): { visible: string; interno: string } {
  const catalogo = MOTIVOS_DECISION[tipo] as Record<string, Motivo>;
  const elegidos = codigos.filter((c) => c in catalogo);
  const visibles = [...new Set(elegidos.filter((c) => c !== OTRO[tipo] || tipo === 'rechazar').map((c) => catalogo[c].visible))];
  const texto = (detalle ?? '').trim();
  const internas = elegidos.map((c) => `${c} · ${catalogo[c].interno}`);
  return {
    visible: visibles.join('; '),
    interno: [...internas, ...(texto ? [`Detalle del analista: ${texto}`] : [])].join('\n'),
  };
}
