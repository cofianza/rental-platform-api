/**
 * Lee el estado de un sobre en Auco (GET /document, public key) y lo imprime.
 * Sirve para cruzar contrato_firmantes con lo que Auco dice de cada firmante.
 *
 *   AUCO_PROBE_CODE=JR7J46OOUN railway run npx ts-node -r tsconfig-paths/register scripts/test-auco-status.ts
 */
import { getDocumentStatus } from '@/lib/auco';

async function main() {
  const code = process.env.AUCO_PROBE_CODE;
  if (!code) throw new Error('Falta AUCO_PROBE_CODE');
  const info = (await getDocumentStatus(code)) as unknown as Record<string, unknown>;
  const mask = (s: string) => s.replace(/(\+?\d{2,3})\d{5,}(\d{2})/g, '$1…$2').replace(/([\w.+-]{2})[\w.+-]*(@[\w.-]+)/g, '$1…$2');
  const resumen = {
    code,
    status: info.status,
    name: info.name,
    createdAt: info.createdAt ?? info.created_at,
    signProfile: info.signProfile,
  };
  console.log(mask(JSON.stringify(resumen, null, 2)));
}
main().catch((e) => { console.error('ERROR:', e instanceof Error ? e.message : e); process.exit(1); });
