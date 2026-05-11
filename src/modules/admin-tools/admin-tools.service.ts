// ============================================================
// Admin Tools — TEMPORAL (Mario, 7-may-2026)
//
// Herramientas operativas para QA: el dashboard del administrador expone
// un boton "Borrar datos de prueba" que limpia el ambiente entre rondas.
// El servicio invoca el RPC `fn_wipe_test_data` que es donde vive la
// logica destructiva (transaccional, FK-safe via DEFERRED).
//
// IMPORTANTE: borrar este modulo (route + controller + service) y la
// migracion 20260507000005 antes de pasar a produccion.
// ============================================================

import { supabase, supabaseAuth } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

const CONFIRM_PHRASE = 'BORRAR-TODO';

export interface WipeTestDataResult {
  ok: true;
  deleted: Record<string, number>;
}

/**
 * Limpia los datos transaccionales y las cuentas no-administrador.
 * Solo callable por administradores (gateado en la ruta) y exige una
 * frase de confirmacion en el body para evitar disparos accidentales.
 */
export async function wipeTestData(
  confirm: string,
  invocadoPor: { id: string; email: string },
): Promise<WipeTestDataResult> {
  if (confirm !== CONFIRM_PHRASE) {
    throw AppError.badRequest(
      `Para confirmar la operacion, envia el campo "confirm" con el valor exacto "${CONFIRM_PHRASE}".`,
      'CONFIRMACION_REQUERIDA',
    );
  }

  logger.warn(
    { invocadoPor: invocadoPor.email, userId: invocadoPor.id },
    'WIPE TEST DATA: invocacion recibida — limpiando base de datos',
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('fn_wipe_test_data');

  if (error) {
    logger.error({ error: error.message }, 'WIPE TEST DATA: RPC fallo');
    throw new AppError(500, 'WIPE_FAILED', `Error al ejecutar el wipe: ${error.message}`);
  }

  const deleted = (data as Record<string, number>) || {};
  logger.warn({ deleted, invocadoPor: invocadoPor.email }, 'WIPE TEST DATA: completado');

  return { ok: true, deleted };
}

export const WIPE_CONFIRM_PHRASE = CONFIRM_PHRASE;

// ============================================================
// Seed de usuarios de prueba para QA
// ============================================================
//
// Crea 3 usuarios de QA con datos colombianos verosimiles via
// supabaseAuth.auth.admin.createUser (que setea correctamente todos los
// campos internos de auth.users — al contrario que un INSERT directo,
// que deja campos como confirmation_token en NULL y causa
// "Database error loading user" despues).
//
// Es idempotente: si los usuarios ya existen, los borra primero.
// TEMPORAL: borrar junto con el resto del modulo admin-tools antes
// de pasar a produccion.

interface TestUserSeed {
  email: string;
  password: string;
  nombre: string;
  apellido: string;
  rol: 'propietario' | 'inmobiliaria' | 'solicitante';
  telefono: string;
  tipoDocumento: 'cc' | 'nit';
  numeroDocumento: string;
  direccion: string;
  ciudad: string;
  // Solo inmobiliaria
  razonSocial?: string;
  nit?: string;
  nombreRepresentante?: string;
  matriculaArrendador?: string;
  // Solo solicitante
  ocupacion?: string;
  empresa?: string;
  ingresosMensuales?: number;
  departamento?: string;
}

const TEST_USERS: TestUserSeed[] = [
  {
    email: 'carlos.propietario@test.com',
    password: 'Test1234*',
    nombre: 'Carlos Andrés',
    apellido: 'Ramírez Gómez',
    rol: 'propietario',
    telefono: '+573105551234',
    tipoDocumento: 'cc',
    numeroDocumento: '80123456',
    direccion: 'Calle 100 # 15-50, Apto 802',
    ciudad: 'Bogotá D.C.',
  },
  {
    email: 'inmobiliaria.valle@test.com',
    password: 'Test1234*',
    nombre: 'Inmobiliaria del Valle',
    apellido: 'S.A.S',
    rol: 'inmobiliaria',
    telefono: '+573154445678',
    tipoDocumento: 'nit',
    numeroDocumento: '901234567',
    direccion: 'Avenida 6N # 28-100, Oficina 502',
    ciudad: 'Cali',
    razonSocial: 'Inmobiliaria del Valle S.A.S',
    nit: '901234567-8',
    nombreRepresentante: 'Juan Pablo Gutiérrez Mejía',
    matriculaArrendador: 'VLL-2024-0732',
  },
  {
    email: 'maria.arrendataria@test.com',
    password: 'Test1234*',
    nombre: 'María Camila',
    apellido: 'Rodríguez Pérez',
    rol: 'solicitante',
    telefono: '+573206789012',
    tipoDocumento: 'cc',
    numeroDocumento: '1043987654',
    direccion: 'Carrera 70 # 1-50, Apto 305',
    ciudad: 'Medellín',
    departamento: 'Antioquia',
    ocupacion: 'Ingeniera de sistemas',
    empresa: 'Bancolombia S.A.',
    ingresosMensuales: 4500000,
  },
];

export interface SeedTestUsersResult {
  ok: true;
  creados: Array<{ email: string; rol: string; id: string }>;
  eliminados_previos: number;
}

export async function seedTestUsers(
  invocadoPor: { id: string; email: string },
): Promise<SeedTestUsersResult> {
  logger.warn(
    { invocadoPor: invocadoPor.email, userId: invocadoPor.id },
    'SEED TEST USERS: creando usuarios de prueba',
  );

  // 1. Limpiar usuarios previos con esos emails para hacer la operacion
  //    idempotente. perfiles tiene FK a auth.users con ON DELETE CASCADE,
  //    pero solicitantes y terminos_aceptaciones referencian al user_id
  //    con políticas distintas — los limpiamos explicitamente antes.
  const emails = TEST_USERS.map((u) => u.email);
  const previosIds: string[] = [];

  const { data: listData } = await supabaseAuth.auth.admin.listUsers({ page: 1, perPage: 200 });
  const matches = (listData?.users ?? []).filter((u) => emails.includes(u.email ?? ''));
  for (const m of matches) {
    previosIds.push(m.id);
    await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('email', m.email!);
    await (supabase
      .from('terminos_aceptaciones' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('user_id', m.id);
    await supabaseAuth.auth.admin.deleteUser(m.id);
  }

  logger.info({ eliminados: previosIds.length }, 'SEED TEST USERS: cleanup previo completado');

  // 2. Crear cada usuario via admin API.
  const creados: Array<{ email: string; rol: string; id: string }> = [];

  for (const seed of TEST_USERS) {
    const { data: created, error: createErr } = await supabaseAuth.auth.admin.createUser({
      email: seed.email,
      password: seed.password,
      email_confirm: true, // marca como verificado, no manda email
      user_metadata: {
        nombre: seed.nombre,
        apellido: seed.apellido,
        rol: seed.rol,
      },
      app_metadata: {
        provider: 'email',
        providers: ['email'],
        role: seed.rol,
      },
    });

    if (createErr || !created?.user) {
      logger.error(
        { email: seed.email, error: createErr?.message },
        'SEED TEST USERS: error creando usuario',
      );
      throw new AppError(500, 'SEED_FAILED', `Error creando ${seed.email}: ${createErr?.message}`);
    }

    const userId = created.user.id;

    // 3. Actualizar perfiles con todos los datos (el trigger creo el perfil
    //    basico; aqui completamos rol + telefono + documento + etc).
    const perfilPatch: Record<string, unknown> = {
      nombre: seed.nombre,
      apellido: seed.apellido,
      rol: seed.rol,
      telefono: seed.telefono,
      tipo_documento: seed.tipoDocumento,
      numero_documento: seed.numeroDocumento,
      direccion: seed.direccion,
      ciudad: seed.ciudad,
      email_verified_at: new Date().toISOString(),
      registration_source: 'admin',
    };
    if (seed.rol === 'inmobiliaria') {
      perfilPatch.razon_social = seed.razonSocial;
      perfilPatch.nit = seed.nit;
      perfilPatch.nombre_representante = seed.nombreRepresentante;
      perfilPatch.representante_legal = seed.nombreRepresentante;
      perfilPatch.direccion_comercial = seed.direccion;
      perfilPatch.domicilio_direccion = seed.direccion;
      perfilPatch.domicilio_ciudad = `${seed.ciudad}, Valle del Cauca`;
      perfilPatch.matricula_arrendador = seed.matriculaArrendador;
    }

    const { error: updPerfilErr } = await (supabase
      .from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .update(perfilPatch as never)
      .eq('id', userId);

    if (updPerfilErr) {
      logger.error(
        { email: seed.email, error: updPerfilErr.message },
        'SEED TEST USERS: error actualizando perfil',
      );
    }

    // 4. Para solicitantes, crear la fila en solicitantes.
    if (seed.rol === 'solicitante') {
      const { error: solErr } = await (supabase
        .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
        .insert({
          nombre: seed.nombre,
          apellido: seed.apellido,
          tipo_documento: seed.tipoDocumento,
          numero_documento: seed.numeroDocumento,
          email: seed.email,
          telefono: seed.telefono,
          tipo_persona: 'natural',
          direccion: seed.direccion,
          ciudad: seed.ciudad,
          departamento: seed.departamento,
          ocupacion: seed.ocupacion,
          empresa: seed.empresa,
          ingresos_mensuales: seed.ingresosMensuales,
          nivel_educativo: 'Profesional',
          habitara_inmueble: true,
          estado: 'activo',
          creado_por: userId,
        } as never);

      if (solErr) {
        logger.error(
          { email: seed.email, error: solErr.message },
          'SEED TEST USERS: error creando solicitante',
        );
      }
    }

    // 5. Aceptaciones de terminos (saltamos el flow publico).
    await (supabase
      .from('terminos_aceptaciones' as string) as ReturnType<typeof supabase.from>)
      .insert({
        user_id: userId,
        acepta_terminos: true,
        acepta_tratamiento_datos: true,
        terminos_aceptados_at: new Date().toISOString(),
        datos_aceptados_at: new Date().toISOString(),
        ip_address: '127.0.0.1',
        user_agent: 'seed-script',
      } as never);

    creados.push({ email: seed.email, rol: seed.rol, id: userId });
    logger.info(
      { email: seed.email, rol: seed.rol, userId },
      'SEED TEST USERS: usuario creado',
    );
  }

  return {
    ok: true,
    creados,
    eliminados_previos: previosIds.length,
  };
}

