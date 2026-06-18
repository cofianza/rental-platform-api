import app from '@/app';
import { env } from '@/config';
import { logger } from '@/lib/logger';

app.listen(env.PORT, () => {
  logger.info(`Server running in ${env.NODE_ENV} mode on http://localhost:${env.PORT}`);
});

// Reconciliación periódica de pagos de pasarela (red de seguridad cuando el
// webhook nunca llega o el pago queda en pending — PSE/efectivo). Solo aplica
// con Mercado Pago; para otros providers la función es no-op.
const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
if (env.PAYMENT_GATEWAY_PROVIDER === 'mercadopago') {
  setInterval(() => {
    import('@/modules/pagos/pagos.service')
      .then(({ reconcilePendingPagos }) => reconcilePendingPagos())
      .catch((err) => logger.warn({ err }, 'reconcilePendingPagos: ciclo fallido'));
  }, RECONCILE_INTERVAL_MS).unref();
}

// Vencimiento de contratos: finaliza automáticamente los contratos vigentes
// cuya fecha_fin ya pasó y libera el inmueble. Corre al arrancar (atrapa los
// que vencieron mientras el server estuvo caído) y cada 6 h.
const VENCIMIENTO_INTERVAL_MS = 6 * 60 * 60 * 1000;
if (env.CONTRATO_VENCIMIENTO_JOB_ENABLED) {
  const runVencimiento = () =>
    import('@/modules/contratos/contrato-vencimiento.service')
      .then(({ finalizarContratosVencidos }) => finalizarContratosVencidos())
      .catch((err) => logger.warn({ err }, 'finalizarContratosVencidos: ciclo fallido'));
  runVencimiento();
  setInterval(runVencimiento, VENCIMIENTO_INTERVAL_MS).unref();
}
