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

// Firma de contratos V3: barrido de respaldo del webhook de Auco (vencimientos,
// rechazos y firmas cuyo aviso se perdió, procesos cortados por un redeploy,
// avisos sin entregar). Atado a los datos y NO a CONTRATOS_V3_ENABLED: los
// sobres de QA (flag encendido en local) mandan sus webhooks a producción.
// Sin sobres V3 solo hace una consulta vacía.
// FIRMA_V3_BARRIDO_ENABLED=false en una API local (su .env.local apunta a producción).
const FIRMA_V3_INTERVAL_MS = 15 * 60 * 1000; // ponytail: una consulta por sobre vivo; bajar la frecuencia si hay volumen
if (env.FIRMA_V3_BARRIDO_ENABLED) {
  const runFirmaV3 = () =>
    import('@/modules/contratos/v3/firma/reconciliar')
      .then(({ barrerFirmasV3 }) => barrerFirmasV3())
      .catch((err) => logger.warn({ err }, 'barrerFirmasV3: ciclo fallido'));
  runFirmaV3();
  setInterval(runFirmaV3, FIRMA_V3_INTERVAL_MS).unref();
}

// Escalada automatica de mora. Antes solo existia como POST /cron/moras/
// auto-escalar protegido por CRON_SECRET, que no esta configurado: nunca corria
// y la pantalla de moras prometia una escalada que no pasaba. Mismo patron que
// el vencimiento de contratos; apagado hasta tener las plantillas en Meta.
const MORAS_INTERVAL_MS = 60 * 60 * 1000;
if (env.MORAS_AUTOESCALAR_ENABLED) {
  const runMoras = () =>
    import('@/modules/moras/moras.service')
      .then(({ autoEscalar }) => autoEscalar())
      .catch((err) => logger.warn({ err }, 'autoEscalar moras: ciclo fallido'));
  runMoras();
  setInterval(runMoras, MORAS_INTERVAL_MS).unref();
}
