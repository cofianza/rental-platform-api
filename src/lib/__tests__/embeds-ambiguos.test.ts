import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

// ============================================================
// Desde la migración 20260903000005 hay DOS relaciones entre expedientes e
// inmuebles (expedientes.inmueble_id e inmuebles.reservado_por_expediente_id).
// Un embed sin hint entre esas dos tablas hace que PostgREST responda 300
// (PGRST201) y la API lo convierte en 500. Pasó dos veces: el detalle del
// estudio (2026-09-07) y TODAS las operaciones de citas (listar, crear,
// confirmar, cancelar y el enlace público de la visita), rotas ~3 semanas.
//
// Este test lee el código y falla si algún select embebe una tabla dentro de
// la otra sin el hint `!expedientes_inmueble_id_fkey` (o el que corresponda).
// ============================================================

const SRC = path.resolve(__dirname, '../..');

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = path.join(dir, nombre);
    if (statSync(ruta).isDirectory()) return nombre === '__tests__' ? [] : archivosTs(ruta);
    return ruta.endsWith('.ts') ? [ruta] : [];
  });
}

/** Texto entre el "(" en `desde` y su ")" correspondiente. */
function cuerpo(texto: string, desde: number): string {
  let profundidad = 1;
  let i = desde;
  while (i < texto.length && profundidad > 0) {
    if (texto[i] === '(') profundidad++;
    else if (texto[i] === ')') profundidad--;
    i++;
  }
  return texto.slice(desde, i - 1);
}

/** Embeds de `hija` sin hint de FK (`!inner` no cuenta como hint) dentro de cada embed de `madre`. */
function sinHint(texto: string, madre: string, hija: string): string[] {
  const hallazgos: string[] = [];
  const reMadre = new RegExp(`[:\\s,(\`'"]${madre}((?:\\s*!\\s*\\w+)*)\\s*\\(`, 'g');
  for (const m of texto.matchAll(reMadre)) {
    const dentro = cuerpo(texto, m.index! + m[0].length);
    const reHija = new RegExp(`\\b${hija}((?:\\s*!\\s*\\w+)*)\\s*\\(`, 'g');
    for (const h of dentro.matchAll(reHija)) {
      const hints = [...h[1].matchAll(/!\s*(\w+)/g)].map((x) => x[1]).filter((x) => x !== 'inner' && x !== 'left');
      if (hints.length === 0) hallazgos.push(dentro.slice(Math.max(0, h.index! - 30), h.index! + 40).replace(/\s+/g, ' '));
    }
  }
  return hallazgos;
}

/** Lo mismo en el primer nivel: `.from('expedientes').select('..., inmuebles(...)')`. */
function sinHintDirecto(texto: string, madre: string, hija: string): string[] {
  const hallazgos: string[] = [];
  for (const m of texto.matchAll(new RegExp(`(?:from|db)\\(\\s*['"]${madre}['"]`, 'g'))) {
    const tramo = texto.slice(m.index!, m.index! + 400);
    const sel = tramo.match(/\.select\(\s*([`'"])([\s\S]*?)\1/);
    if (!sel || /(?:from|db)\(\s*['"]/.test(tramo.slice(m[0].length, sel.index))) continue;
    let profundidad = 0;
    let token = '';
    for (const ch of `${sel[2]},`) {
      if (ch === '(') profundidad++;
      if (ch === ')') profundidad--;
      if (ch === ',' && profundidad === 0) {
        const t = token.trim().match(new RegExp(`^(?:\\w+\\s*:\\s*)?${hija}((?:\\s*!\\s*\\w+)*)\\s*\\(`));
        if (t && ![...t[1].matchAll(/!\s*(\w+)/g)].some((x) => x[1] !== 'inner' && x[1] !== 'left')) {
          hallazgos.push(token.trim().slice(0, 60));
        }
        token = '';
      } else token += ch;
    }
  }
  return hallazgos;
}

describe('embeds de PostgREST entre expedientes e inmuebles', () => {
  it('todo embed de una tabla dentro de la otra lleva hint de FK', () => {
    const problemas = archivosTs(SRC).flatMap((archivo) => {
      const texto = readFileSync(archivo, 'utf8');
      return [
        ...sinHint(texto, 'expedientes', 'inmuebles'),
        ...sinHint(texto, 'inmuebles', 'expedientes'),
        ...sinHintDirecto(texto, 'expedientes', 'inmuebles'),
        ...sinHintDirecto(texto, 'inmuebles', 'expedientes'),
      ].map((h) => `${path.relative(SRC, archivo)}: ${h}`);
    });
    expect(problemas).toEqual([]);
  });

  it('el detector encuentra el caso que rompió las citas', () => {
    const roto = "select(`id, expediente:expedientes (id, inmueble:inmuebles (id, ciudad))`)";
    const bien = "select(`id, expediente:expedientes (id, inmueble:inmuebles!expedientes_inmueble_id_fkey (id))`)";
    expect(sinHint(roto, 'expedientes', 'inmuebles')).toHaveLength(1);
    expect(sinHint(bien, 'expedientes', 'inmuebles')).toHaveLength(0);
    // El del 2026-09-07: embed directo desde expedientes.
    expect(sinHintDirecto("from('expedientes').select('id, inmuebles(direccion)')", 'expedientes', 'inmuebles')).toHaveLength(1);
    expect(
      sinHintDirecto("from('expedientes').select('id, inmuebles!expedientes_inmueble_id_fkey(direccion)')", 'expedientes', 'inmuebles'),
    ).toHaveLength(0);
  });
});
