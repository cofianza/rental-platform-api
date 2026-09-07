/**
 * Backfill del scorecard V4.1 en SOMBRA sobre los estudios ya completados.
 *
 * POR QUE EXISTE. Gerencia pidio el modo sombra para medir el impacto de la
 * Politica V4.1 ANTES de mover un umbral (migracion 20260903000001), y a
 * 2026-09-07 la tabla estudios_scorecard_sombra tenia CERO filas: todos los
 * estudios completados son anteriores al despliegue del motor. Sin datos, las
 * preguntas abiertas para Mario (banda 80-84, corte de 85, regla dura vs
 * ponderacion) se contestan a ciegas.
 *
 * QUE HACE. Toma cada estudio 'completado' que conserve `respuesta_proveedor`
 * (el payload crudo del buro), corre el motor sobre ese payload y persiste la
 * corrida por el MISMO camino que produccion (registrarScorecardSombra con
 * salida precalculada). Es idempotente: upsert por (estudio_id,
 * modelo_version).
 *
 * QUE NO HACE, y es la garantia estructural del modo sombra: NO escribe en
 * `estudios`. Ningun resultado, score, estado ni motivo cambia. Tampoco pasa
 * por reglas-duras.ts: un estudio ya decidido no se re-decide.
 *
 * SOBRE LAS FECHAS. `fecha_calculo` sera hoy —es la verdad: se calculo hoy—
 * pero las ventanas temporales del motor (mora 6/12/24 m, antiguedad) se
 * anclan en el corte de datos del propio payload, no en la fecha de la
 * corrida, asi que evaluar un reporte de agosto en septiembre da lo mismo que
 * haberlo evaluado en agosto.
 *
 * Correr (lee .env.local, que apunta al Supabase de produccion):
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-scorecard-sombra.ts            # solo evalua e imprime
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-scorecard-sombra.ts --write    # ademas persiste
 */

import { supabase } from '@/lib/supabase';
import { evaluarSombra, MODELO_VERSION } from '@/modules/estudios/motor';
import type { SalidaSombra } from '@/modules/estudios/motor';
import { registrarScorecardSombra } from '@/modules/estudios/motor/sombra.service';
// El MISMO lector de canon que usan el tope (§4.4) y las reglas duras: una
// sola definicion de "cual es el canon de este estudio".
import { leerCanonDelInmueble } from '@/modules/estudios/tope-canon.guard';

const WRITE = process.argv.includes('--write');

interface Fila {
  id: string;
  expediente_id: string;
  proveedor: string | null;
  resultado: string;
  score: number | null;
  fecha_completado: string | null;
  respuesta_proveedor: Record<string, unknown> | null;
}

function corto(id: string): string {
  return id.slice(0, 8);
}

function fmt(n: number | null | undefined, sufijo = ''): string {
  return n === null || n === undefined ? 's/d' : `${n}${sufijo}`;
}

async function canonDe(expedienteId: string): Promise<number | null> {
  try {
    const bruto = await leerCanonDelInmueble({ expedienteId });
    const n = typeof bruto === 'string' ? Number(bruto) : bruto;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`\n== Backfill scorecard sombra · ${MODELO_VERSION} · ${WRITE ? 'ESCRIBIENDO' : 'solo lectura (--write para persistir)'} ==\n`);

  const { data, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, proveedor, resultado, score, fecha_completado, respuesta_proveedor')
    .eq('estado', 'completado')
    .not('respuesta_proveedor', 'is', null)
    .order('fecha_completado', { ascending: true });

  if (error) throw new Error(`No se pudieron leer los estudios: ${error.message}`);
  const filas = (data ?? []) as unknown as Fila[];
  console.log(`${filas.length} estudio(s) completados con payload del buro.\n`);

  const resumen: Array<{ real: string; sombra: string }> = [];

  for (const f of filas) {
    const canon = await canonDe(f.expediente_id);
    const salida: SalidaSombra = evaluarSombra({
      proveedor: f.proveedor,
      payload: f.respuesta_proveedor,
      canon_mensual_cop: canon,
      score_persistido: f.score,
    });

    const faltan = salida.variables_no_calculables.join(',') || '—';
    const reglas = salida.reglas_duras.map((r) => r.codigo).join(',') || '—';
    console.log(
      `${corto(f.id)}  ${(f.proveedor ?? '?').padEnd(11)} real=${f.resultado.padEnd(12)} score=${fmt(f.score).padEnd(5)} ` +
        `→ sombra=${salida.decision_sombra.padEnd(15)} pts=${fmt(salida.puntaje_normalizado).padEnd(5)} techo=${fmt(salida.puntaje_maximo_alcanzable).padEnd(5)} ` +
        `dti=${fmt(salida.dti_pct, '%').padEnd(7)} canon/ing=${fmt(salida.canon_ingreso_pct, '%').padEnd(7)} canon=${fmt(canon)}  faltan=${faltan}  reglas=${reglas}`,
    );
    if (salida.motivo_no_calculable) console.log(`          no calculable: ${salida.motivo_no_calculable}`);

    resumen.push({ real: f.resultado, sombra: salida.decision_sombra });

    if (WRITE) {
      // Mismo camino que produccion: solo persiste, no re-evalua, no toca `estudios`.
      await registrarScorecardSombra({
        estudioId: f.id,
        expedienteId: f.expediente_id,
        salidaPrecalculada: salida,
      });
      const { data: row } = await (supabase
        .from('estudios_scorecard_sombra' as string) as ReturnType<typeof supabase.from>)
        .select('decision_sombra, puntaje_normalizado')
        .eq('estudio_id', f.id)
        .eq('modelo_version', MODELO_VERSION)
        .maybeSingle();
      console.log(
        row
          ? `          ✓ persistido (${(row as { decision_sombra: string }).decision_sombra}, ${(row as { puntaje_normalizado: number }).puntaje_normalizado})`
          : '          ✗ NO se persistio (sin variables calculables, o fallo el upsert — ver warnings arriba)',
      );
    }
  }

  // Cruce real vs sombra: la tabla que Gerencia pidio.
  const cruce = new Map<string, number>();
  for (const r of resumen) cruce.set(`${r.real} → ${r.sombra}`, (cruce.get(`${r.real} → ${r.sombra}`) ?? 0) + 1);
  console.log('\n── decision real → decision sombra ──');
  for (const [k, n] of [...cruce.entries()].sort()) console.log(`  ${n}  ${k}`);
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
