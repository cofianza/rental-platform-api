import type { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import { AppError } from '@/lib/errors';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { getCalibracion } from '@/lib/calibracion';
import * as habilitacion from './habilitacion.service';
import * as migracion from './migracion.service';
import * as actaFirma from './acta-firma';
import * as cartera from './cartera.service';
import { CONTENT_TYPE_XLSX, generarPlantilla } from './plantilla';
import type { Destinacion } from './validacion';
import type { GuardarHabilitacionInput, ProcesarInput } from './migracion.schema';

function enviarXlsx(res: Response, buffer: Buffer, nombre: string) {
  res.set('Content-Type', CONTENT_TYPE_XLSX);
  res.set('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send(buffer);
}

function archivoDe(req: Request): Buffer {
  if (!req.file) throw AppError.badRequest('Adjunte el archivo en el campo «archivo».', 'ARCHIVO_REQUERIDO');
  return req.file.buffer;
}

export async function descargarPlantilla(_req: Request, res: Response) {
  const cal = await getCalibracion();
  const buffer = await generarPlantilla({
    meses: cal.MESES_SIN_MORA_REQUERIDOS,
    maxFilas: cal.MAX_FILAS_POR_CARGA,
    topeVivienda: cal.CANON_MAX_TRANSITORIO,
    topeComercial: cal.TOPE_CANON_COMERCIAL,
  });
  enviarXlsx(res, buffer, 'plantilla-migracion-cartera.xlsx');
}

export async function listarInmobiliarias(_req: Request, res: Response) {
  sendSuccess(res, await habilitacion.listarInmobiliarias());
}

export async function estadoOrg(req: Request, res: Response) {
  sendSuccess(res, await habilitacion.estadoMigracionOrg(req.params.inmobiliariaId as string));
}

export async function guardarHabilitacion(req: Request, res: Response) {
  const { inmobiliariaId, destinacion } = req.params as { inmobiliariaId: string; destinacion: Destinacion };
  const fila = await habilitacion.guardarHabilitacion(inmobiliariaId, destinacion, req.body as GuardarHabilitacionInput, req.user!.id);
  logAudit({
    usuarioId: req.user!.id,
    accion: AUDIT_ACTIONS.MIGRACION_HABILITACION_GUARDADA,
    entidad: AUDIT_ENTITIES.MIGRACION_HABILITACION,
    entidadId: fila.id,
    detalle: { inmobiliaria_id: inmobiliariaId, destinacion, ...(req.body as GuardarHabilitacionInput) },
    ip: req.ip,
  });
  sendSuccess(res, fila);
}

export async function cargarDocumento(req: Request, res: Response) {
  const { inmobiliariaId, destinacion, tipo } = req.params as {
    inmobiliariaId: string;
    destinacion: Destinacion;
    tipo: habilitacion.TipoDocumentoHabilitacion;
  };
  const fila = await habilitacion.cargarDocumentoHabilitacion(inmobiliariaId, destinacion, tipo, archivoDe(req));
  logAudit({
    usuarioId: req.user!.id,
    accion: AUDIT_ACTIONS.MIGRACION_DOCUMENTO_CARGADO,
    entidad: AUDIT_ENTITIES.MIGRACION_HABILITACION,
    entidadId: fila.id,
    detalle: { inmobiliaria_id: inmobiliariaId, destinacion, tipo },
    ip: req.ip,
  });
  sendSuccess(res, fila);
}

export async function suspender(req: Request, res: Response) {
  const inmobiliariaId = req.params.inmobiliariaId as string;
  await habilitacion.getOrg(inmobiliariaId);
  const { motivo } = req.body as { motivo: string };
  const suspendida = await habilitacion.suspenderMigraciones(inmobiliariaId, motivo);
  if (suspendida)
    logAudit({
      usuarioId: req.user!.id,
      accion: AUDIT_ACTIONS.MIGRACION_SUSPENDIDA,
      entidad: AUDIT_ENTITIES.INMOBILIARIA,
      entidadId: inmobiliariaId,
      detalle: { motivo, automatica: false },
      ip: req.ip,
    });
  sendSuccess(res, { suspendida: true, ya_estaba_suspendida: !suspendida });
}

export async function reactivar(req: Request, res: Response) {
  const inmobiliariaId = req.params.inmobiliariaId as string;
  await habilitacion.reactivarMigraciones(inmobiliariaId, req.user!);
  logAudit({
    usuarioId: req.user!.id,
    accion: AUDIT_ACTIONS.MIGRACION_REACTIVADA,
    entidad: AUDIT_ENTITIES.INMOBILIARIA,
    entidadId: inmobiliariaId,
    detalle: { email: req.user!.email },
    ip: req.ip,
  });
  sendSuccess(res, { suspendida: false });
}

export async function validar(req: Request, res: Response) {
  const inmobiliariaId = req.params.inmobiliariaId as string;
  const q = (req as Request & { validatedQuery?: { formato: 'json' | 'xlsx' } }).validatedQuery;
  if (q?.formato === 'xlsx') {
    const { buffer } = await migracion.validarArchivoXlsx(inmobiliariaId, archivoDe(req));
    enviarXlsx(res, buffer, 'reporte-validacion-migracion.xlsx');
    return;
  }
  sendSuccess(res, await migracion.validarArchivo(inmobiliariaId, archivoDe(req)));
}

export async function procesar(req: Request, res: Response) {
  const inmobiliariaId = req.params.inmobiliariaId as string;
  const out = await migracion.procesarArchivo(inmobiliariaId, archivoDe(req), req.body as ProcesarInput, req.user!.id);
  logAudit({
    usuarioId: req.user!.id,
    accion: AUDIT_ACTIONS.MIGRACION_LOTE_PROCESADO,
    entidad: AUDIT_ENTITIES.MIGRACION_LOTE,
    entidadId: out.lote.id,
    detalle: { inmobiliaria_id: inmobiliariaId, numero: out.lote.numero, ...out.resumen, exposicion_cop: out.lote.exposicion_cop },
    ip: req.ip,
  });
  sendSuccess(res, out, 201);
}

export async function enviarActa(req: Request, res: Response) {
  const acta = await actaFirma.enviarActa(req.params.loteId as string, req.user!.id);
  sendSuccess(res, { acta_id: acta.id, estado: acta.estado, auco_code: acta.auco_code, expira_en: acta.expira_en }, 201);
}

export async function estadoActa(req: Request, res: Response) {
  sendSuccess(res, await actaFirma.estadoActa(req.params.loteId as string));
}

export async function actaPdf(req: Request, res: Response) {
  sendSuccess(res, await actaFirma.urlActaPdf(req.params.loteId as string));
}

export async function actualizarActa(req: Request, res: Response) {
  sendSuccess(res, await actaFirma.actualizarActa(req.params.loteId as string));
}

export async function cancelarLote(req: Request, res: Response) {
  sendSuccess(res, await actaFirma.cancelarLote(req.params.loteId as string, req.user!.id));
}

// ── Cartera migrada (§5-§8) ──

const query = <T>(req: Request) => (req as Request & { validatedQuery?: T }).validatedQuery as T;
const filaId = (req: Request) => req.params.filaId as string;
const auditoriaId = (req: Request) => req.params.auditoriaId as string;

export async function detalleFila(req: Request, res: Response) {
  sendSuccess(res, await cartera.detalleFila(filaId(req)));
}

export async function marcarRevision(req: Request, res: Response) {
  const { en_revision, motivo } = req.body as { en_revision: boolean; motivo?: string | null };
  sendSuccess(res, await cartera.marcarRevision(filaId(req), en_revision, motivo ?? null, req.user!.id));
}

export async function excluir(req: Request, res: Response) {
  const { nota } = req.body as { nota?: string | null };
  sendSuccess(res, await cartera.excluirContrato(filaId(req), 'declaracion_falsa', nota ?? null, req.user!.id));
}

export async function requerirAuditoria(req: Request, res: Response) {
  const { notas } = req.body as { notas?: string | null };
  sendSuccess(res, await cartera.requerirAuditoria(filaId(req), notas ?? null, req.user!.id), 201);
}

export async function responderAuditoria(req: Request, res: Response) {
  const { notas } = req.body as { notas?: string | null };
  sendSuccess(res, await cartera.registrarRespuestaAuditoria(auditoriaId(req), req.file?.buffer ?? null, notas ?? null, req.user!.id));
}

export async function decidirAuditoria(req: Request, res: Response) {
  const { resultado, notas } = req.body as { resultado: cartera.ResultadoAuditoria; notas?: string | null };
  sendSuccess(res, await cartera.decidirAuditoria(auditoriaId(req), resultado, notas ?? null, req.user!.id));
}

export async function pasarAReportable(req: Request, res: Response) {
  sendSuccess(res, await cartera.pasarAReportable(filaId(req), req.body as { motivo: cartera.MotivoReportable; fecha?: string | null; notas?: string | null }, req.user!.id));
}

export async function listarLotes(req: Request, res: Response) {
  sendSuccess(res, await cartera.listarLotes(query<{ inmobiliariaId?: string }>(req)?.inmobiliariaId));
}

export async function tablero(req: Request, res: Response) {
  const loteId = req.params.loteId as string;
  const q = query<{ formato: 'json' | 'xlsx'; vista: 'cofianza' | 'inmobiliaria' }>(req);
  if (q?.formato === 'xlsx') {
    const { buffer } = await cartera.tableroLoteXlsx(loteId, q.vista);
    enviarXlsx(res, buffer, `tablero-migracion-${loteId}.xlsx`);
    return;
  }
  sendSuccess(res, await cartera.tableroLote(loteId));
}

export async function reporteSinPlantilla(req: Request, res: Response) {
  const q = query<{ formato: 'json' | 'xlsx'; inmobiliariaId?: string }>(req);
  if (q?.formato === 'xlsx') {
    const { buffer } = await cartera.reporteSinPlantillaXlsx(q.inmobiliariaId);
    enviarXlsx(res, buffer, 'migracion-formato-anterior.xlsx');
    return;
  }
  sendSuccess(res, await cartera.reporteSinPlantilla(q?.inmobiliariaId));
}

export async function liquidacion(req: Request, res: Response) {
  const q = query<{ formato: 'json' | 'xlsx'; inmobiliariaId?: string; mes: string }>(req);
  if (q.formato === 'xlsx') {
    const { buffer } = await cartera.liquidacionXlsx(q.mes, q.inmobiliariaId);
    enviarXlsx(res, buffer, `liquidacion-migracion-${q.mes}.xlsx`);
    return;
  }
  sendSuccess(res, await cartera.liquidacion(q.mes, q.inmobiliariaId));
}
