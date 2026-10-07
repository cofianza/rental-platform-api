import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import * as controller from './tarifa-cobro.controller';
import { anularBody, condicionBody, idParams, liquidacionQuery, listarCuentasQuery, pagoBody, terminacionBody } from './tarifa-cobro.schema';

// ============================================================
// /api/v1/tarifa-cobro — cobro de la tarifa mensual (plan cobro-tarifa-mensual).
// Cofianza (administrador u operador) opera todo. De la inmobiliaria, solo los
// titulares ven sus cuentas y marcan «no recaudada» (el service lo verifica con
// tenantScope; solo_lectura no muta por el middleware). Gerencia General anula.
// ============================================================

const router = Router();
router.use(authMiddleware);

const COFIANZA = roleGuard(['administrador', 'operador_analista']);

router.get('/cuentas', roleGuard(['administrador', 'operador_analista', 'inmobiliaria']), validate({ query: listarCuentasQuery }), controller.listarCuentas);
router.get('/cuentas/:id', roleGuard(['administrador', 'operador_analista', 'inmobiliaria']), validate({ params: idParams }), controller.obtenerCuenta);
// Reintentar la factura es volver a emitir: si Factus falla, la cuenta queda en «emitiendo» (líneas congeladas) y se retoma pasados 10 min; la factura se recupera por la referencia.
router.post('/cuentas/:id/emitir', roleGuard(['administrador']), validate({ params: idParams }), controller.emitir);
router.post('/cuentas/:id/pagar', COFIANZA, validate({ params: idParams, body: pagoBody }), controller.pagarCuenta);

router.post('/lineas/:id/pagar', COFIANZA, validate({ params: idParams, body: pagoBody }), controller.pagarLinea);
router.post('/lineas/:id/anular', roleGuard(['administrador']), validate({ params: idParams, body: anularBody }), controller.anularLinea);
router.patch('/lineas/:id/no-recaudada', roleGuard(['inmobiliaria']), validate({ params: idParams }), controller.marcarNoRecaudada);

router.patch('/contratos/:id/terminacion-efectiva', COFIANZA, validate({ params: idParams, body: terminacionBody }), controller.terminacionEfectiva);
router.post('/contratos/:id/condiciones-cobro', roleGuard(['administrador', 'inmobiliaria']), validate({ params: idParams, body: condicionBody }), controller.registrarCondicion);

router.get('/reportes/liquidacion.xlsx', COFIANZA, validate({ query: liquidacionQuery }), controller.liquidacionXlsx);

export default router;
