import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import { assertExpedienteAccess } from '@/lib/tenantScope';
import { AppError } from '@/lib/errors';
import * as service from './creditos-estudios.service';
import type {
  ComprarPaqueteInput,
  CreatePaqueteInput,
  UpdatePaqueteInput,
  ListMovimientosQuery,
  PaqueteIdParams,
  LiberarEstudioCreditoInput,
  CompraIdParams,
  FacturarCompraInput,
} from './creditos-estudios.schema';

// ============================================================
// Inmobiliaria
// ============================================================

export async function listPaquetes(_req: Request, res: Response) {
  const data = await service.listPaquetesActivos();
  sendSuccess(res, data);
}

export async function getMiSaldo(req: Request, res: Response) {
  const data = await service.getSaldoCreditos(req.user!.id);
  sendSuccess(res, data);
}

export async function getMisMovimientos(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery: ListMovimientosQuery }).validatedQuery;
  const result = await service.listMovimientos(req.user!.id, query);
  sendSuccess(res, result.movimientos, 200, result.pagination);
}

export async function getMisCompras(req: Request, res: Response) {
  const data = await service.listCompras(req.user!.id);
  sendSuccess(res, data);
}

export async function comprarPaquete(req: Request, res: Response) {
  const input = req.body as ComprarPaqueteInput;
  const result = await service.comprarPaquete(req.user!.id, input.paquete_id, req.user!.id, req.ip);
  sendCreated(res, result);
}

// ============================================================
// Facturar compra de paquete — POST /creditos-estudios/me/compras/:id/facturar
//
// Body opcional con datos fiscales (razon_social, nit, direccion, email,
// telefono, municipio_codigo, etc.). Si no vienen, se leen del perfil.
// Si faltan datos requeridos, retorna 400 con details.faltantes para que
// el frontend muestre el modal pidiendolos.
// ============================================================

export async function facturarCompra(req: Request, res: Response) {
  const { id } = req.params as unknown as CompraIdParams;
  const override = (req.body || {}) as FacturarCompraInput;
  const { crearFacturaDesdeCompraCreditos } = await import('@/modules/facturacion/facturacion.service');
  // Cofianza (admin/operador) factura desde Pendientes de facturación la compra
  // de cualquier organización: null = sin chequeo de pertenencia.
  const interno = req.user!.rol === 'administrador' || req.user!.rol === 'operador_analista';
  const result = await crearFacturaDesdeCompraCreditos(
    id,
    interno ? null : req.user!.id,
    override,
    req.user!.id,
    req.ip,
  );
  sendCreated(res, result);
}

// ============================================================
// Liberar estudio (consumir credito) — POST /expedientes/:id/liberar-estudio-credito
// ============================================================

export async function liberarEstudio(req: Request, res: Response) {
  const expedienteId = (req.params as { expedienteId: string }).expedienteId;
  const input = (req.body || {}) as LiberarEstudioCreditoInput;
  // El estudio tiene que estar en su cartera, como en cancelarYLiberarCredito
  // (404 fuera de ella): el asesor restringido no gasta créditos en estudios de
  // sus compañeros. El servicio solo mira la organización del inmueble.
  await assertExpedienteAccess(expedienteId, req.user!.id, req.user!.rol);
  // H99: Cofianza (admin/operador) paga con un crédito de la inmobiliaria dueña
  // del estudio. Mismo servicio (saldo, P22, cobro vivo, tope, pago + consumo
  // atómico, bitácora, gate de pago): el saldo es el del titular de la org y
  // el movimiento/auditoría guardan a quien lo liberó.
  const rol = req.user!.rol;
  let perfilCreditos = req.user!.id;
  let notas = input.notas;
  const pagaCofianza = rol === 'administrador' || rol === 'operador_analista';
  if (pagaCofianza) {
    const dueno = await service.duenoCreditosDeExpediente(expedienteId);
    if (!dueno) {
      throw AppError.conflict(
        'Este estudio no es de una inmobiliaria: no hay créditos de paquete para pagar la evaluación.',
        'SIN_INMOBILIARIA',
      );
    }
    perfilCreditos = dueno;
    notas = notas || 'Liberado por Cofianza con crédito del paquete de la inmobiliaria';
  }
  const result = await service.liberarEstudioConCredito(expedienteId, perfilCreditos, req.user!.id, req.ip, notas);
  // Si lo gastó Cofianza, la inmobiliaria se entera (best-effort, sin esperar).
  if (pagaCofianza) {
    void service.avisarCreditoUsadoPorCofianza(expedienteId, result.saldo_restante);
  }
  sendCreated(res, result);
}

// H99: saldo usable de la inmobiliaria dueña del estudio (modal interno).
// GET /expedientes/:id/liberar-estudio-credito/saldo — solo admin/operador.
export async function getSaldoInmobiliariaDeExpediente(req: Request, res: Response) {
  const expedienteId = (req.params as { expedienteId: string }).expedienteId;
  sendSuccess(res, await service.saldoCreditosDeExpediente(expedienteId));
}

// ============================================================
// Super admin — CRUD paquetes
// ============================================================

export async function adminListPaquetes(_req: Request, res: Response) {
  const data = await service.listAllPaquetes();
  sendSuccess(res, data);
}

export async function adminCreatePaquete(req: Request, res: Response) {
  const input = req.body as CreatePaqueteInput;
  const data = await service.createPaquete(input, req.user!.id);
  sendCreated(res, data);
}

export async function adminUpdatePaquete(req: Request, res: Response) {
  const { id } = req.params as unknown as PaqueteIdParams;
  const input = req.body as UpdatePaqueteInput;
  const data = await service.updatePaquete(id, input, req.user!.id);
  sendSuccess(res, data);
}

export async function adminDeletePaquete(req: Request, res: Response) {
  const { id } = req.params as unknown as PaqueteIdParams;
  await service.deletePaquete(id, req.user!.id);
  sendSuccess(res, { ok: true });
}
