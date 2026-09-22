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

import type { AucoDocumentInfo, AucoRoadmap, AucoSignerStatus, AucoSignProfile } from '@/lib/auco';
import { normalizePhoneToInternational } from '@/lib/auco';
import { aucoDeriveCountry, mapTipoDocumentoToAuco } from '@/modules/firma/firma-multiparte.service';

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

/**
 * signProfile de Auco: `order` da el turno (el siguiente se notifica cuando
 * firma el anterior) y `label` coloca la firma sobre el ancla `{{signature:i}}`
 * del PDF, donde i es la posición en este arreglo. El canal es WhatsApp + OTP,
 * como el flujo anterior. Cofianza no va (§6.4).
 */
export function construirSignProfile(partes: ParteFirmante[]): AucoSignProfile[] {
  return [...partes]
    .sort((a, b) => a.orden - b.orden)
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
 */
export const AVISO_FIRMA_INCOMPLETA_VERSION = 'e5-11.7.4-v1';

export function textoAvisoFirmaIncompleta(x: {
  numero: string;
  direccion: string;
  motivo: 'EXPIRED' | 'REJECTED' | string | null;
  detalle?: string | null;
  crcVigenteHasta?: string | null;
}): string {
  const causa =
    x.motivo === 'EXPIRED'
      ? 'venció el plazo para firmar'
      : `una de las partes rechazó la firma${x.detalle ? ` (${x.detalle})` : ''}`;
  const reenvio = x.crcVigenteHasta
    ? ` Puedes reenviarlo a firma mientras el estudio siga vigente (hasta el ${x.crcVigenteHasta}).`
    : ' Puedes reenviarlo a firma mientras el estudio siga vigente.';
  return (
    `El proceso de firma del contrato ${x.numero} (${x.direccion}) terminó sin que firmaran todas las partes: ${causa}. ` +
    'La fianza de COFIANZA S.A.S. NO está operando y COFIANZA S.A.S. no responde por este inmueble mientras la firma esté incompleta. ' +
    'Entregar el inmueble en estas condiciones es decisión y responsabilidad exclusiva de la inmobiliaria.' +
    reenvio
  );
}
