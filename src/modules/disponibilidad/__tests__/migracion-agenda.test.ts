import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';

// ============================================================
// P37, migración 20261001000007: fn_slots_disponibles y fn_slot_esta_disponible
// se copiaron del cuerpo DESPLEGADO y solo cambia qué visitas ocupan la franja
// (las de todos los inmuebles de la organización del titular). Sin Postgres en
// las pruebas, esto fija que no se coló otro cambio: al devolver la condición
// vieja, el cuerpo es idéntico al de producción (md5 de pg_proc.prosrc tomado
// el 2026-09-24). Si alguien edita el cuerpo, esta prueba lo dice.
// ============================================================

const SQL = readFileSync(
  path.resolve(__dirname, '../../../../supabase/migrations/20261001000007_cobranza_en_horario_y_agenda_por_inmobiliaria.sql'),
  'utf-8',
);
const NUEVA =
  'WHERE (i.propietario_id = p_propietario_id\n' +
  '            OR i.inmobiliaria_id IN (SELECT o.id FROM inmobiliarias o WHERE o.owner_perfil_id = p_propietario_id))';
const VIEJA = 'WHERE i.propietario_id = p_propietario_id';
const DESPLEGADO: Record<string, string> = {
  fn_slots_disponibles: '4e4b8a40a7e0728cfbf018b9aea1360c',
  fn_slot_esta_disponible: '7017a5a80fbda6af4e00aef240151993',
};

function cuerpo(funcion: string): string {
  const m = SQL.match(new RegExp(`FUNCTION public\\.${funcion}\\([^)]*\\)[\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`));
  if (!m) throw new Error(`${funcion} no está en la migración`);
  return m[1];
}

describe('migración de la agenda por inmobiliaria', () => {
  it.each([
    ['fn_slots_disponibles', 1],
    ['fn_slot_esta_disponible', 2],
  ])('%s: solo cambia la ocupación (%i lugares) respecto a lo desplegado', (funcion, lugares) => {
    const nuevo = cuerpo(funcion);
    expect(nuevo.split(NUEVA).length - 1).toBe(lugares);
    expect(nuevo).not.toContain(`${VIEJA}\n`);
    const md5 = createHash('md5').update(nuevo.split(NUEVA).join(VIEJA)).digest('hex');
    expect(md5).toBe(DESPLEGADO[funcion]);
  });
});
