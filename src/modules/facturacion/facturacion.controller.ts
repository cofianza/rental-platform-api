import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import { AppError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { assertExpedienteAccess } from '@/lib/tenantScope';
import * as service from './facturacion.service';
import * as factus from '@/lib/factus';

export async function list(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await service.listFacturas(req.query as any, req.user!.id, req.user!.rol);
  sendSuccess(res, result.facturas, { pagination: result.pagination } as never);
}

export async function listPendientesFacturar(req: Request, res: Response) {
  const result = await service.listPendientesFacturar(req.user!.id, req.user!.rol);
  sendSuccess(res, result);
}

export async function getById(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const result = await service.getFacturaById(id, req.user!.id, req.user!.rol);
  sendSuccess(res, result);
}

export async function previewFacturaPago(req: Request, res: Response) {
  const { pagoId } = req.params as { pagoId: string };

  // Guard de pertenencia uniforme para TODOS los roles scopeados
  // (solicitante, propietario, inmobiliaria) — evita espiar datos fiscales
  // de pagos ajenos. Roles internos / llamadas sin identidad: no-op.
  await assertPagoAccess(pagoId, req.user!.id, req.user!.rol);

  const result = await service.previewFacturaPago(pagoId);
  sendSuccess(res, result);
}

export async function facturarPago(req: Request, res: Response) {
  const { pagoId } = req.params as { pagoId: string };
  const body = (req.body || {}) as Record<string, string | undefined>;
  // Si el body trae al menos un campo de override, lo pasamos al service
  // (modo estricto: faltantes -> error CLIENTE_DATOS_INCOMPLETOS).
  const hasOverride = Object.values(body).some((v) => v !== undefined && v !== '');
  const override = hasOverride ? body : undefined;

  // Guard de pertenencia uniforme (ver assertPagoAccess). Antes solo corria
  // para 'solicitante'; propietario/inmobiliaria podian facturar pagos de
  // cualquier expediente fuera de su cartera (IDOR) — ahora todos validan.
  await assertPagoAccess(pagoId, req.user!.id, req.user!.rol);

  const result = await service.crearFacturaDesdePago(pagoId, req.user!.id, req.ip, override);
  sendSuccess(res, result, undefined, 201);
}

/**
 * Guard de pertenencia por pago para los endpoints de facturación por pago.
 * Resuelve el expediente del pago y delega en assertExpedienteAccess (única
 * fuente de verdad del scoping): no-op para roles internos y llamadas sin
 * identidad; 404 para roles scopeados fuera de su cartera (solicitante vía
 * solicitantes.creado_por; propietario/inmobiliaria vía cartera de inmuebles).
 */
async function assertPagoAccess(
  pagoId: string,
  userId?: string,
  userRol?: string,
): Promise<void> {
  const { data: pagoRow } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id')
    .eq('id', pagoId)
    .maybeSingle();

  const expedienteId = (pagoRow as { expediente_id?: string | null } | null)?.expediente_id;
  if (!expedienteId) {
    throw AppError.notFound('Pago no encontrado', 'PAGO_NOT_FOUND');
  }
  await assertExpedienteAccess(expedienteId, userId, userRol);
}

export async function searchMunicipalities(req: Request, res: Response) {
  const name = String(req.query.name || '').trim();
  if (name.length < 2) {
    sendSuccess(res, []);
    return;
  }
  const result = await factus.searchMunicipalities(name);
  sendSuccess(res, result);
}

export async function getTarifasIva(_req: Request, res: Response) {
  const result = await service.listTarifasIva();
  sendSuccess(res, result);
}

export async function updateTarifasIva(req: Request, res: Response) {
  const body = req.body as { tarifas: { concepto: string; tasa: number }[] };
  const result = await service.updateTarifasIva(body.tarifas, req.user!.id, req.ip);
  sendSuccess(res, result);
}

// ============================================================
// Descarga PDF / XML directo desde Factus
//
// Factus V2 no devuelve URLs persistentes — la descarga se hace por endpoint
// `/v2/bills/:number/download-pdf|download-xml` que retorna el archivo en
// base64. Este controlador hace de proxy: obtiene el archivo en base64,
// lo decodifica y lo devuelve con headers de descarga al navegador.
// ============================================================

const MIME_BY_TIPO: Record<'pdf' | 'xml', string> = {
  pdf: 'application/pdf',
  xml: 'application/xml',
};

export async function downloadFactusDocumento(req: Request, res: Response) {
  const { id, tipo } = req.params as { id: string; tipo: 'pdf' | 'xml' };
  if (tipo !== 'pdf' && tipo !== 'xml') {
    throw AppError.badRequest('Tipo invalido — usar pdf o xml', 'TIPO_INVALIDO');
  }

  // getFacturaById aplica el guard multi-tenant por-id (404 si el usuario no
  // puede ver la factura) ANTES de firmar/descargar el PDF/XML desde Factus.
  const factura = await service.getFacturaById(id, req.user!.id, req.user!.rol);
  if (!factura) throw AppError.notFound('Factura no encontrada');

  const f = factura as unknown as { factus_number?: string | null; numero?: string | null };
  const billNumber = f.factus_number || f.numero || null;
  if (!billNumber) {
    throw AppError.badRequest(
      'La factura aun no tiene numero asignado por Factus',
      'FACTURA_SIN_NUMERO_FACTUS',
    );
  }

  const inline = req.query.inline === 'true';

  let buffer: Buffer;
  let fileName: string;

  if (tipo === 'pdf') {
    const r = await factus.downloadBillPdf(billNumber);
    buffer = Buffer.from(r.pdf_base_64_encoded, 'base64');
    fileName = r.file_name || `${billNumber}.pdf`;
  } else {
    const r = await factus.downloadBillXml(billNumber);
    buffer = Buffer.from(r.xml_base_64_encoded, 'base64');
    fileName = r.file_name || `${billNumber}.xml`;
  }

  res.setHeader('Content-Type', MIME_BY_TIPO[tipo]);
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${fileName.replace(/"/g, '')}"`,
  );
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(buffer);
}
