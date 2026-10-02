/**
 * Borra de Storage los archivos de las pruebas previas al arranque (compañero
 * de revisiones/sql-a-correr/borrado-pruebas-2026-09-30.sql, que va ANTES: el
 * SQL tiene el freno y es atómico; si se detiene, los archivos siguen intactos).
 * Con --ejecutar se niega a borrar mientras queden inmuebles o expedientes en la base.
 *
 * Por defecto SOLO LISTA: cuántos archivos y cuánto pesan, por bucket y carpeta.
 * Con --ejecutar: descarga cada archivo a ~/respaldos-cofianza/archivos-<fecha>/<bucket>/<ruta>
 * y solo si la descarga salió completa lo borra (en lotes de 100).
 *
 * Se conserva lo que es de las cuentas: logos del arrendador y documentos
 * legales de la inmobiliaria. Tampoco se toca nada subido después del respaldo
 * analizado (puede ser de un cliente real). Solo imprime rutas y conteos.
 *
 *   DOTENV_CONFIG_PATH=.env.local npx ts-node -r dotenv/config -r tsconfig-paths/register scripts/borrar-archivos-pruebas.ts
 *   DOTENV_CONFIG_PATH=.env.local npx ts-node -r dotenv/config -r tsconfig-paths/register scripts/borrar-archivos-pruebas.ts --ejecutar
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { supabase } from '@/lib/supabase';

const EJECUTAR = process.argv.includes('--ejecutar');
const CORTE = new Date('2026-09-30T12:51:19-06:00'); // respaldo prod-2026-09-30-1251.dump
const BUCKETS = ['documentos-expedientes', 'inmuebles', 'pagos-comprobantes', 'inmuebles-fotos'];
const CONSERVAR: Record<string, string[]> = {
  'documentos-expedientes': ['logos-arrendador/', 'documentos-legales/'],
};

interface Archivo { ruta: string; bytes: number; creado: string | null }

async function listar(bucket: string, prefijo = ''): Promise<Archivo[]> {
  const out: Archivo[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefijo, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`No pude listar ${bucket}/${prefijo}: ${error.message}`);
    for (const it of data) {
      const ruta = prefijo ? `${prefijo}/${it.name}` : it.name;
      if (!it.id) out.push(...(await listar(bucket, ruta))); // sin id = carpeta
      else out.push({ ruta, bytes: Number(it.metadata?.size ?? 0), creado: it.created_at ?? null });
    }
    if (data.length < 1000) return out;
  }
}

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(2)} MB`;
const carpeta = (ruta: string) => (ruta.includes('/') ? `${ruta.split('/')[0]}/` : '(raíz)');

async function main() {
  const fecha = new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD, hora local
  const destino = path.join(homedir(), 'respaldos-cofianza', `archivos-${fecha}`);
  if (EJECUTAR) {
    for (const tabla of ['inmuebles', 'expedientes'] as const) {
      const { count, error } = await supabase.from(tabla).select('id', { count: 'exact', head: true });
      if (error) throw new Error(`No pude contar ${tabla}: ${error.message}`);
      if (count) throw new Error(`DETENIDO: ${tabla} todavía tiene ${count} fila(s). Corra primero el SQL del borrado; no se borró ningún archivo.`);
    }
  }
  console.log(EJECUTAR ? `MODO EJECUTAR: descarga a ${destino} y luego borra.\n` : 'SOLO LISTA (no descarga ni borra nada). Para ejecutar: --ejecutar\n');

  const total = { borrar: 0, bytes: 0, conservados: 0, nuevos: 0, descargados: 0, fallidos: 0, borrados: 0 };

  for (const bucket of BUCKETS) {
    const todos = await listar(bucket);
    const conservar = CONSERVAR[bucket] ?? [];
    const conservados = todos.filter((a) => conservar.some((p) => a.ruta.startsWith(p)));
    const nuevos = todos.filter((a) => !conservados.includes(a) && a.creado && new Date(a.creado) > CORTE);
    const borrar = todos.filter((a) => !conservados.includes(a) && !nuevos.includes(a));
    const bytes = borrar.reduce((s, a) => s + a.bytes, 0);

    console.log(`== ${bucket}: ${todos.length} archivos · a borrar ${borrar.length} (${mb(bytes)}) · se conservan ${conservados.length} · posteriores al respaldo (no se tocan) ${nuevos.length}`);
    const porCarpeta = new Map<string, number>();
    for (const a of borrar) porCarpeta.set(carpeta(a.ruta), (porCarpeta.get(carpeta(a.ruta)) ?? 0) + 1);
    for (const [c, n] of porCarpeta) console.log(`   ${c.padEnd(24)} ${n}`);
    total.borrar += borrar.length; total.bytes += bytes;
    total.conservados += conservados.length; total.nuevos += nuevos.length;

    if (!EJECUTAR || borrar.length === 0) continue;

    const listos: string[] = [];
    for (const a of borrar) {
      const { data, error } = await supabase.storage.from(bucket).download(a.ruta);
      const buf = data ? Buffer.from(await data.arrayBuffer()) : null;
      if (error || !buf || (a.bytes > 0 && buf.length !== a.bytes)) {
        total.fallidos++;
        console.log(`   NO SE BORRA (descarga fallida): ${bucket}/${a.ruta}`);
        continue;
      }
      const archivo = path.join(destino, bucket, a.ruta);
      await mkdir(path.dirname(archivo), { recursive: true, mode: 0o700 });
      await writeFile(archivo, buf, { mode: 0o600 });
      listos.push(a.ruta);
      total.descargados++;
    }

    for (let i = 0; i < listos.length; i += 100) {
      const lote = listos.slice(i, i + 100);
      const { data, error } = await supabase.storage.from(bucket).remove(lote);
      if (error) console.log(`   Lote ${i / 100 + 1} no se pudo borrar: ${error.message} (quedó descargado igual)`);
      total.borrados += data?.length ?? 0;
    }
    console.log(`   descargados ${listos.length} · borrados hasta ahora ${total.borrados}`);
  }

  console.log(`\nRESUMEN: a borrar ${total.borrar} (${mb(total.bytes)}) · conservados ${total.conservados} · posteriores al respaldo ${total.nuevos}`);
  if (EJECUTAR) {
    console.log(`descargados ${total.descargados} · fallidos ${total.fallidos} · borrados ${total.borrados}`);
    console.log(`Copia en: ${destino}`);
    if (total.fallidos > 0 || total.borrados !== total.descargados) process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error('ERROR:', e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => process.exit()); // el Agent keep-alive de @/lib/supabase no deja salir solo
