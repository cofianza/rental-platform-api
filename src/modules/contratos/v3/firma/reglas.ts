/**
 * Contratos V3 — firma: reglas puras (Entrega 5, diseño §3.6, §5.2 y §7.1).
 *
 * Sin Supabase, sin red y sin reloj salvo donde se dice: aquí vive todo lo que
 * decide qué se manda a Auco y qué significa lo que Auco contesta. Los efectos
 * (crear el sobre, transicionar el contrato, avisar) viven en firma.service.ts
 * y reconciliar.ts.
 *
 * Reglas de la spec V3 que se aplican aquí:
 *   §6.3-6.5  firman arrendatario → coarrendatario(s) → arrendador, en ese
 *             orden; Cofianza NO firma;
 *   §11.3     FIRMA INCOMPLETA = el proceso se cerró (rechazo) o venció;
 *   §11.7.2   la fecha de activación es la de la ÚLTIMA firma que reporta Auco.
 */

import type { PDFDocument, PDFPage } from 'pdf-lib';
import type { AucoDocumentInfo, AucoRoadmap, AucoSignerStatus, AucoSignProfile } from '@/lib/auco';
import { normalizePhoneToInternational } from '@/lib/auco';
import { AppError } from '@/lib/errors';
import { aucoDeriveCountry, mapTipoDocumentoToAuco } from '@/modules/firma/firma-multiparte.service';
import type { MarcaFirma } from '../asistente.types';
import { fechaBogota } from '../formato';

/** Fila de `contrato_partes` (congelada fuera de borrador) en lo que la firma necesita. */
export interface ParteFirmante {
  id: string;
  rol: 'arrendatario' | 'coarrendatario' | 'arrendador';
  orden: number;
  nombre: string;
  tipo_documento: string | null;
  numero_documento: string | null;
  email: string | null;
  telefono: string | null;
  representante_legal_nombre?: string | null;
  representante_legal_tipo_documento?: string | null;
  representante_legal_documento?: string | null;
}

export type EstadoFirmante = 'pendiente' | 'notificado' | 'firmado' | 'rechazado' | 'bloqueado';

/** Un elemento de `contrato_v3_sobres.firmantes` (JSONB), en orden de firma. */
export interface FirmanteSobre {
  parteId: string;
  estado: EstadoFirmante;
  /** Id del firmante en Auco (GET /document); sirve para recordatorio o desbloqueo. */
  aucoId?: string | null;
  /** Hora de su firma según el roadmap de Auco (UTC). */
  firmadoEn?: string | null;
}

/** Quién firma y con qué datos: el arrendador firma por su representante legal (§6.3). */
export function datosDeFirma(p: ParteFirmante): {
  nombre: string;
  email: string | null;
  telefono: string | null;
  tipoDocumento: string | null;
  documento: string | null;
} {
  const esArrendador = p.rol === 'arrendador';
  return {
    nombre: (esArrendador ? p.representante_legal_nombre : p.nombre) ?? p.nombre,
    email: p.email,
    telefono: p.telefono,
    // El NIT no sirve para firmar: Auco solo acepta documentos de persona natural.
    tipoDocumento: esArrendador ? (p.representante_legal_tipo_documento ?? null) : p.tipo_documento,
    documento: esArrendador ? (p.representante_legal_documento ?? null) : p.numero_documento,
  };
}

/**
 * Motivos por los que un sobre no se puede crear. Auco exige teléfono y correo
 * distintos por firmante (el OTP va por WhatsApp y el emparejamiento posterior
 * es por correo), así que un duplicado rompe el sobre entero.
 */
export function validarFirmantes(partes: ParteFirmante[]): { rol: string; motivo: string }[] {
  const fallas: { rol: string; motivo: string }[] = [];
  const telefonos = new Map<string, string>();
  const correos = new Map<string, string>();
  for (const p of partes) {
    const d = datosDeFirma(p);
    if (!d.nombre?.trim()) fallas.push({ rol: p.rol, motivo: 'Falta el nombre de quien firma.' });
    const correo = d.email?.trim().toLowerCase();
    if (!correo) fallas.push({ rol: p.rol, motivo: 'Falta el correo.' });
    else if (correos.has(correo))
      fallas.push({ rol: p.rol, motivo: `El correo ${correo} ya lo usa ${correos.get(correo)}: cada firmante necesita el suyo.` });
    else correos.set(correo, p.rol);
    const tel = normalizePhoneToInternational(d.telefono);
    if (!d.telefono?.trim()) fallas.push({ rol: p.rol, motivo: 'Falta el celular.' });
    else if (!tel) fallas.push({ rol: p.rol, motivo: `El celular «${d.telefono}» no es un número válido.` });
    else if (telefonos.has(tel))
      fallas.push({ rol: p.rol, motivo: `El celular ${tel} ya lo usa ${telefonos.get(tel)}: cada firmante necesita el suyo.` });
    else telefonos.set(tel, p.rol);
    if (p.rol === 'arrendador' && !d.documento?.trim())
      fallas.push({ rol: p.rol, motivo: 'Falta el documento del representante legal.' });
  }
  return fallas;
}

/** Las partes son las que el documento imprime: arrendatario, N coarrendatarios y arrendador. */
export function partesCompletas(partes: ParteFirmante[], coarrendatarios: number): boolean {
  if (partes.length !== 2 + coarrendatarios) return false;
  const ordenadas = [...partes].sort((a, b) => a.orden - b.orden);
  return (
    ordenadas[0].rol === 'arrendatario' &&
    ordenadas[ordenadas.length - 1].rol === 'arrendador' &&
    ordenadas.slice(1, -1).every((p) => p.rol === 'coarrendatario') &&
    ordenadas.every((p, i) => p.orden === i + 1)
  );
}

/** Las partes en orden de firma: el índice es el del firmante en signProfile. */
const enOrden = (partes: ParteFirmante[]) => [...partes].sort((a, b) => a.orden - b.orden);

/**
 * signProfile de Auco: `order` da el turno (el siguiente se notifica cuando
 * firma el anterior) y `label` coloca la firma sobre el ancla `{{signature:i}}`
 * del PDF, donde i es la posición en este arreglo. El canal es WhatsApp + OTP,
 * como el flujo anterior. Cofianza no va (§6.4).
 * `posiciones[i]` (Ruta B): además, las firmas del firmante i sobre el PDF de
 * la inmobiliaria (posicionesDeFirma).
 */
export function construirSignProfile(partes: ParteFirmante[], posiciones?: PosicionAuco[][]): AucoSignProfile[] {
  return enOrden(partes)
    .map((p, i) => {
      const d = datosDeFirma(p);
      const telefono = normalizePhoneToInternational(d.telefono);
      const tipo = mapTipoDocumentoToAuco(d.tipoDocumento);
      const pais = aucoDeriveCountry(telefono);
      const perfil: AucoSignProfile = {
        name: d.nombre,
        email: (d.email ?? '').trim(),
        phone: telefono ?? undefined,
        order: String(i + 1),
        label: true,
        otpCode: true,
        options: { whatsapp: true, otpCode: 'phone' },
      };
      // identification/identificationType van juntos o no van (Auco 400 si el tipo no es de persona).
      if (tipo && d.documento) {
        perfil.identification = d.documento;
        perfil.identificationType = tipo;
        if (pais) perfil.country = pais;
      }
      if (posiciones?.[i]?.length) perfil.position = posiciones[i];
      return perfil;
    });
}

/** Estado de un firmante en Auco → el nuestro. */
export function mapEstadoFirmante(s: AucoSignerStatus | string | undefined): EstadoFirmante {
  switch (s) {
    case 'FINISH':
      return 'firmado';
    case 'REJECT':
      return 'rechazado';
    case 'BLOCK':
      return 'bloqueado';
    case 'NOTIFICATION':
      return 'notificado';
    default:
      return 'pendiente';
  }
}

const correoDe = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/**
 * Copia a nuestros firmantes lo que dice Auco. El emparejamiento es por correo
 * (GET /document no trae teléfono) y los correos son únicos por sobre. Una
 * firma ya registrada no se degrada: Auco no "des-firma".
 */
export function actualizarFirmantes(
  firmantes: FirmanteSobre[],
  partes: ParteFirmante[],
  signProfile: { id?: string; email?: string; status?: AucoSignerStatus | string }[] | undefined,
): FirmanteSobre[] {
  const porCorreo = new Map((signProfile ?? []).map((s) => [correoDe(s.email), s]));
  const parte = new Map(partes.map((p) => [p.id, p]));
  return firmantes.map((f) => {
    const p = parte.get(f.parteId);
    const s = p ? porCorreo.get(correoDe(datosDeFirma(p).email)) : undefined;
    if (!s) return f;
    const estado = mapEstadoFirmante(s.status);
    return {
      ...f,
      aucoId: s.id ?? f.aucoId ?? null,
      estado: f.estado === 'firmado' ? 'firmado' : estado,
    };
  });
}

interface FirmaRoadmap {
  participante: string;
  fecha: string;
  ms: number;
}

/** Firmas (`PARTICIPANT_SIGN`) con fecha válida, en orden de aparición. */
function firmasDelRoadmap(roadmap: AucoRoadmap | null | undefined): FirmaRoadmap[] {
  return (roadmap?.activityLog ?? [])
    .filter((a) => a.action === 'PARTICIPANT_SIGN' && a.timestamp && a.participant)
    .map((a) => ({ participante: String(a.participant), fecha: String(a.timestamp), ms: Date.parse(String(a.timestamp)) }))
    .filter((a) => Number.isFinite(a.ms));
}

/**
 * Fecha de activación (§11.7.2): la última firma que reporta Auco, en UTC.
 * Devuelve null si el roadmap todavía no trae `n` participantes distintos con
 * PARTICIPANT_SIGN — así nunca se activa con una fecha inventada; el barrido
 * reintenta.
 */
export function ultimaFirma(roadmap: AucoRoadmap | null | undefined, n: number): string | null {
  const firmas = firmasDelRoadmap(roadmap);
  if (new Set(firmas.map((f) => f.participante)).size < n) return null;
  const max = Math.max(...firmas.map((f) => f.ms));
  return new Date(max).toISOString();
}

/**
 * Hora de firma de cada firmante, del roadmap. Los ids del roadmap no son los
 * del GET /document (C-4), así que se empareja por teléfono normalizado y, si
 * el participante no trae teléfono, por correo.
 */
export function fechasDeFirma(
  firmantes: FirmanteSobre[],
  partes: ParteFirmante[],
  roadmap: AucoRoadmap | null | undefined,
): FirmanteSobre[] {
  const firmas = new Map(firmasDelRoadmap(roadmap).map((f) => [f.participante, f.fecha]));
  if (firmas.size === 0) return firmantes;
  const porTelefono = new Map<string, string>();
  const porCorreo = new Map<string, string>();
  for (const p of roadmap?.participants ?? []) {
    if (!p.id) continue;
    const tel = normalizePhoneToInternational(p.phone);
    if (tel) porTelefono.set(tel, p.id);
    if (p.email) porCorreo.set(correoDe(p.email), p.id);
  }
  const parte = new Map(partes.map((p) => [p.id, p]));
  return firmantes.map((f) => {
    if (f.firmadoEn || f.estado !== 'firmado') return f;
    const p = parte.get(f.parteId);
    if (!p) return f;
    const d = datosDeFirma(p);
    const tel = normalizePhoneToInternational(d.telefono);
    const id = (tel && porTelefono.get(tel)) ?? porCorreo.get(correoDe(d.email));
    const fecha = id ? firmas.get(id) : undefined;
    return fecha ? { ...f, firmadoEn: fecha } : f;
  });
}

/**
 * Qué hacer con el sobre según lo que dice Auco (§11.3-11.4):
 *   - FINISH                     → activar la fianza;
 *   - EXPIRED / REJECTED, o un
 *     firmante en REJECT         → FIRMA INCOMPLETA;
 *   - BLOCK (3 OTP fallidos)     → nada: sigue EN FIRMA y Cofianza desbloquea;
 *   - CREATED o desconocido      → nada.
 */
export function decidir(
  info: Pick<AucoDocumentInfo, 'status'> | { status?: string },
  firmantes: FirmanteSobre[],
): 'activar' | 'incompleta' | 'nada' {
  if (info.status === 'FINISH') return 'activar';
  if (info.status === 'EXPIRED' || info.status === 'REJECTED') return 'incompleta';
  if (firmantes.some((f) => f.estado === 'rechazado')) return 'incompleta';
  return 'nada';
}

// ── Ruta B (Adenda 1 del módulo de contratos, respuesta 6, condición 3) ──
//
// En la Ruta B las firmas van sobre las líneas de firma de CADA documento. El
// Anexo de Cofianza lleva sus anclas {{signature:N}} (label: true); el PDF de la
// inmobiliaria no se toca: ella marca dónde firma cada parte
// (datos_variables.propio.firmas) y esas marcas van a Auco como `position`, así
// que cada firmante lleva las dos cosas. Al enviar a firma se congelan con la
// geometría de sus páginas en documento.final.firmasPropio: el reenvío y el
// reintento usan exactamente esas, sobre el mismo PDF unido.

/** Caja visible de una página (CropBox, o MediaBox) en puntos y su /Rotate normalizado. */
export interface PaginaPdf {
  ancho: number;
  alto: number;
  rotacion: 0 | 90 | 180 | 270;
}

/** Lo que se congela al enviar: las marcas y la geometría de cada página marcada (clave: su número). */
export interface FirmasPropio {
  marcas: MarcaFirma[];
  paginas: Record<string, PaginaPdf>;
}

/** Un elemento de `position` de Auco: página desde 1, x/y relativos (0-1), w/h en puntos. */
export interface PosicionAuco {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** El recuadro que ocupa una firma en Auco, en puntos (el mismo que dibuja la web). */
export const RECUADRO_FIRMA = { w: 150, h: 50 } as const;

/**
 * La geometría de una página como la muestra un visor (pdf.js): el CropBox (o
 * el MediaBox) y el /Rotate; uno que no es múltiplo de 90 se ignora, como en pdf.js.
 * ponytail: el CropBox no se recorta contra el MediaBox (pdf.js sí); uno que se sale es rarísimo.
 */
export function paginaPdf(p: PDFPage): PaginaPdf {
  const { width, height } = p.getCropBox();
  const r = p.getRotation().angle;
  const rotacion = (r % 90 ? 0 : ((r % 360) + 360) % 360) as PaginaPdf['rotacion'];
  return { ancho: Math.abs(width), alto: Math.abs(height), rotacion };
}

/** Lo que se congela al enviar: las marcas y la geometría de las páginas marcadas, leída del PDF que se firma. */
export function congelarFirmas(doc: PDFDocument, marcas: MarcaFirma[]): FirmasPropio {
  const usadas = [...new Set(marcas.map((m) => m.pagina))];
  return { marcas, paginas: Object.fromEntries(usadas.map((n) => [n, paginaPdf(doc.getPage(n - 1))])) };
}

/**
 * Una marca → un `position` de Auco. La marca es el punto de la raya donde se
 * apoya la firma: el recuadro (w×h puntos) va centrado en ella y con su borde
 * inferior encima.
 *
 * SUPUESTO, a verificar con scripts/sonda-auco-ruta-b.ts: Auco mide sobre la
 * página tal como se ve (CropBox y /Rotate aplicados), con el origen arriba a
 * la izquierda, y su (x, y) es la esquina INFERIOR DERECHA del recuadro:
 * x = (firmaX + w) / ancho, y = (firmaY + h) / alto. Si la sonda dice otra
 * cosa se corrige solo aquí: lo congelado son las marcas y la geometría.
 */
export function posicionAuco(
  m: Pick<MarcaFirma, 'pagina' | 'x' | 'y'>,
  pagina: PaginaPdf,
  { w, h }: { w: number; h: number } = RECUADRO_FIRMA,
): PosicionAuco {
  const [ancho, alto] = pagina.rotacion % 180 ? [pagina.alto, pagina.ancho] : [pagina.ancho, pagina.alto];
  const firmaX = m.x * ancho - w / 2; // borde izquierdo del recuadro, desde la izquierda
  const firmaY = m.y * alto - h; // borde superior del recuadro, desde arriba
  const rel = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1e4) / 1e4;
  return { page: m.pagina, x: rel((firmaX + w) / ancho), y: rel((firmaY + h) / alto), w, h };
}

type RolFirmante = ParteFirmante['rol'];
const ROL_LEGIBLE: Record<RolFirmante, string> = {
  arrendatario: 'Arrendatario',
  coarrendatario: 'Coarrendatario',
  arrendador: 'Arrendador',
};

/** «Arrendatario (Juan Pérez)»: así se dice qué parte falta. */
export const nombreFirmante = (rol: RolFirmante, nombre: string | null | undefined) =>
  nombre?.trim() ? `${ROL_LEGIBLE[rol]} (${nombre.trim()})` : ROL_LEGIBLE[rol];

/** De quién es una marca: el coarrendatario, con su índice. */
const claveMarca = (m: Pick<MarcaFirma, 'parte' | 'indice'>) =>
  m.parte === 'coarrendatario' ? `coarrendatario:${m.indice ?? 0}` : m.parte;

/** La clave de cada firmante, en orden de firma: arrendatario, coarrendatario:0…, arrendador. */
function claves(roles: RolFirmante[]): string[] {
  let k = 0;
  return roles.map((r) => (r === 'coarrendatario' ? `coarrendatario:${k++}` : r));
}

/** Marcas de una parte que no firma este contrato. */
export function marcasAjenas(roles: RolFirmante[], marcas: MarcaFirma[]): MarcaFirma[] {
  const firman = new Set(claves(roles));
  return marcas.filter((m) => !firman.has(claveMarca(m)));
}

/** Los firmantes (en orden de firma, con su nombre legible) que no tienen ninguna marca. */
export function faltanMarcas(firmantes: { rol: RolFirmante; etiqueta: string }[], marcas: MarcaFirma[] = []): string[] {
  const marcadas = new Set(marcas.map(claveMarca));
  const c = claves(firmantes.map((f) => f.rol));
  return firmantes.filter((_, i) => !marcadas.has(c[i])).map((f) => f.etiqueta);
}

export const motivoSinMarcas = (faltan: string[]) =>
  `Falta ubicar en el contrato de la inmobiliaria dónde firma: ${faltan.join(', ')}.`;

/** 409 si alguna parte que firma no tiene dónde firmar en el PDF propio. */
export function exigirMarcas(firmantes: { rol: RolFirmante; etiqueta: string }[], marcas: MarcaFirma[] | undefined): void {
  const faltan = faltanMarcas(firmantes, marcas);
  if (faltan.length) throw new AppError(409, 'RUTA_B_FIRMAS_INCOMPLETAS', motivoSinMarcas(faltan), { partes: faltan });
}

/** Los firmantes de contrato_partes, en orden de firma: el arrendador, por su representante legal. */
export const firmantesDePartes = (partes: ParteFirmante[]) =>
  enOrden(partes).map((p) => ({ rol: p.rol, etiqueta: nombreFirmante(p.rol, datosDeFirma(p).nombre) }));

/**
 * Ruta B: las posiciones de cada firmante (índice = orden de firma) sobre el
 * PDF propio, con las marcas congeladas al enviar; 409 si a alguno le falta.
 * Ruta A: undefined (solo las anclas).
 */
export function posicionesDeFirma(
  partes: ParteFirmante[],
  final: { ruta?: 'A' | 'B'; firmasPropio?: FirmasPropio } | undefined,
): PosicionAuco[][] | undefined {
  if (final?.ruta !== 'B') return undefined;
  const marcas = final.firmasPropio?.marcas;
  exigirMarcas(firmantesDePartes(partes), marcas);
  const paginas = final.firmasPropio!.paginas;
  return claves(enOrden(partes).map((p) => p.rol)).map((clave) =>
    marcas!.filter((m) => claveMarca(m) === clave).map((m) => posicionAuco(m, paginas[m.pagina])),
  );
}

// ── Plazo de firma (Adenda 1 del módulo de contratos, respuesta 10) ──

const DIA_MS = 86_400_000;
/** Auco rechaza un vencimiento a 3 días o menos de la creación (EXPIRED_DATE_INVALID): una hora de holgura. */
const MINIMO_AUCO_MS = 3 * DIA_MS + 3_600_000;

/** Último instante del día AAAA-MM-DD en Bogotá: un plazo en días corre hasta la medianoche del último día. */
export const finDelDia = (fecha: string): number => Date.parse(`${fecha}T23:59:59-05:00`);

const masPlazo = (desde: number, dias: number) => finDelDia(fechaBogota(new Date(desde + dias * DIA_MS)));

/** Un instante en Bogotá: 'dd/mm/aaaa a las HH:MM'. */
export function fechaHora(ms: number): string {
  const iso = new Date(ms - 5 * 3_600_000).toISOString();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} a las ${iso.slice(11, 16)}`;
}

export type SinPlazo = 'vencido' | 'sin_margen';

/**
 * Plazo de un proceso de firma nuevo: DIAS_EXPIRACION_FIRMA sin pasar el fin
 * exacto del CRC. Auco no deja mover el vencimiento de un proceso vivo: a Auco
 * va lo máximo que el proceso puede durar con su única prórroga (tope CRC) y
 * el plazo de Cofianza (expira_en) lo cierra el barrido. Auco exige más de 3
 * días: con menos vigencia de CRC el proceso duraría más que el CRC, así que no
 * se abre (se renueva la evaluación).
 */
export function plazoDeFirma(
  ahora: number,
  dias: number,
  finCrc: number,
): { expiraEn: number; aucoExpira: number } | { motivo: SinPlazo } {
  if (finCrc <= ahora) return { motivo: 'vencido' };
  if (finCrc - ahora < MINIMO_AUCO_MS) return { motivo: 'sin_margen' };
  return {
    expiraEn: Math.min(masPlazo(ahora, dias), finCrc),
    aucoExpira: Math.min(masPlazo(ahora, 2 * dias), finCrc),
  };
}

/** Por qué no se abre un proceso de firma. */
export const motivoSinPlazo = (m: SinPlazo, finCrc?: number | null): string =>
  m === 'vencido'
    ? 'El certificado de riesgo ya no está vigente: se requiere una nueva evaluación.'
    : `Al certificado de riesgo le quedan menos de tres días de vigencia${finCrc ? ` (vence el ${fechaHora(finCrc)})` : ''}: no alcanza para el proceso de firma. Hay que renovar la evaluación.`;

/**
 * El plazo de un proceso nuevo, o el 409 con lo que hay que hacer (CRC vencido
 * o sin margen). Lo usan enviar a firma, reenviar y crearSobre.
 */
export function exigirPlazoDeFirma(
  finCrc: number | null,
  dias: number,
  ahora = Date.now(),
): { expiraEn: number; aucoExpira: number } {
  const p = finCrc === null ? ({ motivo: 'vencido' } as const) : plazoDeFirma(ahora, dias, finCrc);
  if ('motivo' in p)
    throw AppError.conflict(motivoSinPlazo(p.motivo, finCrc), p.motivo === 'vencido' ? 'CRC_VENCIDO' : 'CRC_SIN_MARGEN');
  return p;
}

/**
 * Fin exacto de la vigencia del CRC: su fecha_vencimiento, la misma que usa
 * /verificar; si no viene, el mismo cálculo con que se emite (fecha de
 * completado + VIGENCIA_CRC_DIAS). null = sin fechas: no se puede saber.
 */
export function finDelCrc(
  fechaVencimiento: string | null | undefined,
  fechaCompletado: string | null | undefined,
  vigenciaDias: number,
): number | null {
  const vence = Date.parse(fechaVencimiento ?? '');
  if (Number.isFinite(vence)) return vence;
  const completado = Date.parse(fechaCompletado ?? '');
  return Number.isFinite(completado) ? completado + vigenciaDias * DIA_MS : null;
}

/** Tolerancia de reloj entre Auco y Cofianza al comparar la última firma con el plazo. */
export const TOLERANCIA_RELOJ_MS = 10 * 60_000;

/**
 * ¿La última firma (hora del roadmap de Auco) llegó tarde? Tarde = después del
 * plazo más una tolerancia corta de reloj o, en ningún caso, después del fin
 * del CRC. Una firma tardía no activa la fianza.
 */
export function fueraDePlazo(ultimaFirma: string, expiraEn: string, finCrc: number | null): boolean {
  return Date.parse(ultimaFirma) > Math.min(Date.parse(expiraEn) + TOLERANCIA_RELOJ_MS, finCrc ?? Infinity);
}

/**
 * La única prórroga: otros `dias` sobre el plazo vigente, sin pasar el CRC ni
 * el vencimiento que se le mandó a Auco (allá no se puede mover). Solo antes de que venza.
 */
export function prorrogaDelPlazo(
  expiraEn: number,
  dias: number,
  finCrc: number,
  ahora: number,
  topeAuco: number | null = null,
): { hasta: number } | { motivo: 'vencido' | 'crc' } {
  if (expiraEn <= ahora) return { motivo: 'vencido' };
  const hasta = Math.min(masPlazo(expiraEn, dias), finCrc, topeAuco ?? Infinity);
  return hasta > expiraEn ? { hasta } : { motivo: 'crc' };
}

/**
 * Id del sobre en `custom`. La doc de Auco lo documenta como objeto en el
 * upload y como arreglo de strings en el webhook: se busca con una expresión
 * sobre el JSON, que sirve para las dos formas. Sin `custom` usable, null.
 */
export function sobreIdDeCustom(custom: unknown): string | null {
  const texto = typeof custom === 'string' ? custom : JSON.stringify(custom ?? '');
  const m = /cofianza_sobre['"]?\s*[:=]\s*['"]?([0-9a-f-]{36})/i.exec(texto);
  return m ? m[1] : null;
}

/**
 * Aviso de §11.7.4: la inmobiliaria tiene que enterarse de que la fianza NO
 * está operando, y queda constancia de la entrega. El texto se versiona: la
 * constancia guarda la versión y el texto exacto que se entregó.
 * v3 (Adenda 1 del módulo de contratos): firmas fuera del plazo, el margen de
 * CRC para reenviar y que el aviso se acepta en la plataforma (respuesta 11).
 */
export const AVISO_FIRMA_INCOMPLETA_VERSION = 'e5-11.7.4-v3';

export function textoAvisoFirmaIncompleta(x: {
  numero: string;
  direccion: string;
  motivo: 'EXPIRED' | 'REJECTED' | 'FUERA_PLAZO' | string | null;
  detalle?: string | null;
  /** Hasta cuándo va el CRC ('dd/mm/aaaa a las HH:MM'), si todavía alcanza para reenviar; null = no alcanza. */
  crcVigenteHasta?: string | null;
}): string {
  const detalle = x.detalle ? ` (${x.detalle})` : '';
  const causa =
    x.motivo === 'EXPIRED'
      ? 'venció el plazo para firmar'
      : x.motivo === 'FUERA_PLAZO'
        ? `las firmas se completaron después del plazo para firmar${detalle} y no cuentan`
        : `una de las partes rechazó la firma${detalle}`;
  // Sin fecha: al CRC no le queda vigencia para un proceso nuevo (reenviar da 409).
  const reenvio = x.crcVigenteHasta
    ? ` Puedes reenviarlo a firma mientras al certificado de riesgo le queden más de tres días de vigencia (vence el ${x.crcVigenteHasta}).`
    : ' Al certificado de riesgo no le queda vigencia suficiente: para volver a enviarlo a firma se requiere una nueva evaluación.';
  return (
    `El proceso de firma del contrato ${x.numero} (${x.direccion}) terminó sin que firmaran todas las partes: ${causa}. ` +
    'La fianza de COFIANZA S.A.S. NO está operando y COFIANZA S.A.S. no responde por este inmueble mientras la firma esté incompleta. ' +
    'Entregar el inmueble en estas condiciones es decisión y responsabilidad exclusiva de la inmobiliaria.' +
    reenvio +
    ' Para reenviarlo a firma o cancelarlo, primero acepta este aviso en la plataforma de COFIANZA S.A.S.: queda registrado quién lo aceptó y cuándo.'
  );
}
