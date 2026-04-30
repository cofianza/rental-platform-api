import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import { AppError } from '@/lib/errors';
import * as service from './facturacion.service';
import * as factus from '@/lib/factus';

export async function list(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await service.listFacturas(req.query as any, req.user!.id, req.user!.rol);
  sendSuccess(res, result.facturas, { pagination: result.pagination } as never);
}

export async function getById(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const result = await service.getFacturaById(id);
  sendSuccess(res, result);
}

export async function previewFacturaPago(req: Request, res: Response) {
  const { pagoId } = req.params as { pagoId: string };

  // Mismo guard de pertenencia que facturarPago — evita que un solicitante
  // espie datos fiscales de otros pagos.
  if (req.user!.rol === 'solicitante') {
    await assertPagoBelongsToSolicitante(pagoId, req.user!.id);
  }

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

  // Si el caller es solicitante, validamos pertenencia: solo puede
  // facturar pagos de SU expediente. Admin/operador/inmobiliaria/
  // propietario operan sin este check (gestores del expediente).
  if (req.user!.rol === 'solicitante') {
    await assertPagoBelongsToSolicitante(pagoId, req.user!.id);
  }

  const result = await service.crearFacturaDesdePago(pagoId, req.user!.id, req.ip, override);
  sendSuccess(res, result, undefined, 201);
}

async function assertPagoBelongsToSolicitante(pagoId: string, userId: string): Promise<void> {
  const { supabase } = await import('@/lib/supabase');
  const { AppError } = await import('@/lib/errors');

  const { data: pagoRow } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, expediente_id,
      expediente:expedientes!pagos_expediente_id_fkey(
        solicitante:solicitantes!expedientes_solicitante_id_fkey(creado_por)
      )
    `)
    .eq('id', pagoId)
    .single();

  const owner = (pagoRow as unknown as {
    expediente?: { solicitante?: { creado_por?: string | null } | null } | null;
  } | null)?.expediente?.solicitante?.creado_por;

  if (!owner || owner !== userId) {
    throw AppError.forbidden(
      'No tienes permisos para facturar este pago.',
      'NOT_OWNER',
    );
  }
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

  const factura = await service.getFacturaById(id);
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
