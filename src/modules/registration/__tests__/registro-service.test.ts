import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Registro v2: los UPDATE secundarios (precarga de «Datos para contrato» y
// columnas de la migración 20261003001001) no pueden tumbar el alta; el UPDATE
// principal sí la revierte. Mismo mock de Supabase con colas por tabla.
// ============================================================

const { mockFrom, ops, enqueue, resetQueues, mockDeleteUser, mockCreateUser } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'is', 'gt', 'limit']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    resetQueues: () => queues.clear(),
    mockDeleteUser: vi.fn(async (..._args: unknown[]): Promise<{ error: { message: string } | null }> => ({ error: null })),
    mockCreateUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => mockFrom(t) },
  supabaseAuth: { auth: { admin: { createUser: mockCreateUser, deleteUser: mockDeleteUser } } },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/email', () => ({ sendVerificationEmail: vi.fn(async () => undefined) }));
vi.mock('@/lib/tenantScope', () => ({ ensureOrgConOwner: vi.fn() }));
vi.mock('@/lib/companyConfig', () => ({ getCompany: async () => ({ email: 'contacto@cofianza.co' }) }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: { USER_DELETED: 'user_deleted' },
  AUDIT_ENTITIES: { USER: 'user' },
}));

import { registerInmobiliaria, registerPropietario } from '../registration.service';
import type { RegisterInmobiliariaInput, RegisterPropietarioInput } from '../registration.schema';
import { sendVerificationEmail } from '@/lib/email';
import { logger } from '@/lib/logger';
import { logAudit } from '@/lib/auditLog';

const comunes = {
  email: 'ana@ejemplo.co',
  telefono: '+57 3001112233',
  password: 'Secreta123',
  confirm_password: 'Secreta123',
  accept_terms: true as const,
  accept_data_treatment: true as const,
};
const INMOBILIARIA: RegisterInmobiliariaInput = {
  ...comunes,
  razon_social: 'Inmobiliaria Norte S.A.S.',
  nit: '900123456-8',
  direccion_comercial: 'Carrera 43A # 1-50',
  ciudad: 'Medellín',
  nombre_representante_nombre: 'Luis',
  nombre_representante_apellido: 'Gómez',
  cargo_representante: 'Director comercial',
  representante_tipo_documento: 'cc',
  representante_documento: '71234567',
  inmuebles_gestionados: '21-50',
  sitio_web: 'https://inmonorte.co',
  origen: 'evento',
};
const PROPIETARIO: RegisterPropietarioInput = {
  ...comunes,
  nombre: 'Ana',
  apellido: 'Paz',
  tipo_documento: 'cc',
  numero_documento: '1040567890',
  origen: 'redes',
};

const updatesDePerfil = () =>
  ops.filter((o) => o.table === 'perfiles' && o.method === 'update').map((o) => o.args[0] as Record<string, unknown>);
const COLUMNA_INEXISTENTE = { error: { message: "Could not find the 'origen_registro' column", code: 'PGRST204' } };

beforeEach(() => {
  resetQueues();
  ops.length = 0;
  mockDeleteUser.mockClear();
  mockCreateUser.mockClear();
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logAudit).mockClear();
});

describe('registerInmobiliaria', () => {
  it('precarga los datos para contrato y guarda los datos comerciales en UPDATE separados', async () => {
    await registerInmobiliaria(INMOBILIARIA, '1.2.3.4', 'test');

    const [principal, precarga, comerciales] = updatesDePerfil();
    expect(principal).toMatchObject({ rol: 'inmobiliaria', nit: '900123456-8', registration_source: 'email' });
    // Las columnas nuevas no viajan en el UPDATE principal: sin la migración lo tumbarían.
    expect(principal).not.toHaveProperty('origen_registro');
    expect(principal).not.toHaveProperty('representante_legal');
    expect(precarga).toEqual({
      domicilio_direccion: 'Carrera 43A # 1-50',
      domicilio_ciudad: 'Medellín',
      representante_legal: 'Luis Gómez',
      representante_legal_tipo_documento: 'cc',
      representante_legal_documento: '71234567',
    });
    expect(comerciales).toEqual({ origen_registro: 'evento', inmuebles_gestionados: '21-50', sitio_web: 'https://inmonorte.co' });
  });

  it('el payload de la web anterior no escribe el UPDATE de datos comerciales', async () => {
    await registerInmobiliaria({
      ...INMOBILIARIA,
      representante_tipo_documento: undefined,
      representante_documento: undefined,
      inmuebles_gestionados: undefined,
      sitio_web: undefined,
      origen: undefined,
    }, '1.2.3.4', 'test');

    const updates = updatesDePerfil();
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual({
      domicilio_direccion: 'Carrera 43A # 1-50',
      domicilio_ciudad: 'Medellín',
      representante_legal: 'Luis Gómez',
    });
  });

  it('si fallan la precarga y los datos comerciales, el registro termina bien y no borra el usuario', async () => {
    // select NIT, UPDATE principal ok, precarga falla, comerciales fallan (migración sin correr).
    enqueue('perfiles', { data: null, error: null }, { error: null }, { error: { message: 'check violation' } }, COLUMNA_INEXISTENTE);

    await expect(registerInmobiliaria(INMOBILIARIA, '1.2.3.4', 'test')).resolves.toMatchObject({
      message: expect.stringContaining('Registro exitoso'),
    });
    expect(mockDeleteUser).not.toHaveBeenCalled();
    // El alta siguió: quedó la aceptación legal y el token de verificación.
    expect(ops.some((o) => o.table === 'terminos_aceptaciones' && o.method === 'insert')).toBe(true);
    expect(ops.some((o) => o.table === 'email_verification_tokens' && o.method === 'insert')).toBe(true);
  });

  it('23505 en el UPDATE principal: NIT_ALREADY_EXISTS y borra el usuario', async () => {
    enqueue('perfiles', { data: null, error: null }, { error: { message: 'duplicate key', code: '23505' } });

    await expect(registerInmobiliaria(INMOBILIARIA, '1.2.3.4', 'test')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'NIT_ALREADY_EXISTS',
    });
    expect(mockDeleteUser).toHaveBeenCalledWith('user-1');
    expect(updatesDePerfil()).toHaveLength(1);
  });
});

// Un registro de inmobiliaria que nunca verificó el correo retenía su NIT para
// siempre: quien tecleó mal el correo no podía volver a registrarse y leía
// «pídale al titular que lo invite». Solo ese caso libera el NIT, y solo cuando
// su enlace de verificación ya venció.
describe('registerInmobiliaria — el NIT ya lo tiene otra cuenta', () => {
  const SIN_VERIFICAR = { data: { id: 'viejo', registration_source: 'email', email_verified_at: null }, error: null };
  const registrar = () => registerInmobiliaria(INMOBILIARIA, '1.2.3.4', 'test');
  const consultaDeTokens = () => ops.filter((o) => o.table === 'email_verification_tokens');

  it('autorregistro sin verificar con el enlace vencido: borra esa cuenta y sigue con el alta', async () => {
    enqueue('perfiles', SIN_VERIFICAR);
    enqueue('email_verification_tokens', { data: null, error: null }); // no le queda enlace vigente

    await expect(registrar()).resolves.toMatchObject({ message: expect.stringContaining('Registro exitoso') });

    // Pregunta por un enlace sin usar y sin vencer de ESA cuenta.
    const [, porCuenta, sinUsar, sinVencer] = consultaDeTokens();
    expect(porCuenta).toMatchObject({ method: 'eq', args: ['user_id', 'viejo'] });
    expect(sinUsar).toMatchObject({ method: 'is', args: ['used_at', null] });
    expect(sinVencer).toMatchObject({ method: 'gt', args: ['expires_at', expect.any(String)] });
    expect(Math.abs(Date.parse(sinVencer.args[1] as string) - Date.now())).toBeLessThan(5000);

    expect(mockDeleteUser).toHaveBeenCalledTimes(1);
    expect(mockDeleteUser).toHaveBeenCalledWith('viejo');
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ usuarioId: null, accion: 'user_deleted', entidadId: 'viejo' }),
    );
  });

  it('autorregistro sin verificar con el enlace vigente: 409 que dice qué hacer, y no borra nada', async () => {
    enqueue('perfiles', SIN_VERIFICAR);
    enqueue('email_verification_tokens', { data: { id: 'token-vigente' }, error: null });

    const error = await registrar().catch((e) => e);

    expect(error).toMatchObject({ statusCode: 409, errorCode: 'NIT_ALREADY_EXISTS' });
    expect(error.message).toBe(
      'Ya hay un registro con este NIT pendiente de verificar el correo. Revise su bandeja de entrada (y el spam). ' +
        'Si escribió mal el correo, podrá registrarse de nuevo en 24 horas o escribirnos a contacto@cofianza.co.',
    );
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it.each([
    ['verificada', { registration_source: 'email', email_verified_at: '2026-09-01T00:00:00Z' }],
    ['creada por un administrador', { registration_source: 'admin', email_verified_at: null }],
    ['de un miembro invitado', { registration_source: 'invitacion_miembro', email_verified_at: '2026-09-01T00:00:00Z' }],
    ['sin origen registrado', { registration_source: null, email_verified_at: null }],
  ])('cuenta %s: el 409 de siempre, y nunca se borra', async (_caso, estado) => {
    enqueue('perfiles', { data: { id: 'viejo', ...estado }, error: null });

    await expect(registrar()).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'NIT_ALREADY_EXISTS',
      message: 'Ya hay una inmobiliaria registrada con este NIT. Pídale al titular de la cuenta que lo invite a su equipo.',
    });
    expect(consultaDeTokens()).toHaveLength(0);
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('si no se puede saber si el enlace sigue vigente, no borra', async () => {
    enqueue('perfiles', SIN_VERIFICAR);
    enqueue('email_verification_tokens', { data: null, error: { message: 'connection reset' } });

    await expect(registrar()).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'NIT_ALREADY_EXISTS',
      message: expect.stringContaining('pendiente de verificar el correo'),
    });
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('si la cuenta vencida no se puede borrar, responde 409 con el contacto y no crea otra', async () => {
    enqueue('perfiles', SIN_VERIFICAR);
    mockDeleteUser.mockResolvedValueOnce({ error: { message: 'Database error deleting user' } });

    await expect(registrar()).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'NIT_ALREADY_EXISTS',
      message: 'Ya hay un registro con este NIT que quedó sin verificar y no pudimos liberarlo. Escríbanos a contacto@cofianza.co y lo resolvemos.',
    });
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('registerPropietario', () => {
  it('sin dirección no escribe la columna; el origen va en un UPDATE aparte', async () => {
    await registerPropietario(PROPIETARIO, '1.2.3.4', 'test');

    const [principal, origen] = updatesDePerfil();
    expect(principal).toMatchObject({ rol: 'propietario', estado: 'inactivo', registration_source: 'email' });
    expect(principal).not.toHaveProperty('direccion');
    expect(principal).not.toHaveProperty('origen_registro');
    expect(origen).toEqual({ origen_registro: 'redes' });
  });

  it('si falla el UPDATE del origen, el registro termina bien', async () => {
    enqueue('perfiles', { error: null }, COLUMNA_INEXISTENTE);

    await expect(registerPropietario(PROPIETARIO, '1.2.3.4', 'test')).resolves.toBeDefined();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it('si falla el UPDATE principal, borra el usuario y responde 500', async () => {
    enqueue('perfiles', { error: { message: 'boom' } });

    await expect(registerPropietario(PROPIETARIO, '1.2.3.4', 'test')).rejects.toMatchObject({ statusCode: 500 });
    expect(mockDeleteUser).toHaveBeenCalledWith('user-1');
    expect(ops.some((o) => o.table === 'email_verification_tokens')).toBe(false);
  });
});

// Resend no lanza cuando rechaza un correo; email.ts ahora sí. El alta no se cae
// por eso (la persona puede pedir el reenvío), pero ya no queda como «enviado».
describe('correo de verificación', () => {
  const enviado = () => vi.mocked(logger.info).mock.calls.some(([, msg]) => msg === 'Email de verificacion enviado');

  it('si el proveedor lo rechaza, el registro termina bien y queda el motivo en el log', async () => {
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new Error('Resend rate_limit_exceeded: Too many requests'));

    await expect(registerPropietario(PROPIETARIO, '1.2.3.4', 'test')).resolves.toMatchObject({
      message: expect.stringContaining('Registro exitoso'),
    });
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(enviado()).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Resend rate_limit_exceeded: Too many requests', email: 'ana@ejemplo.co' }),
      'Error al enviar email de verificacion',
    );
  });

  it('si sale, queda como enviado', async () => {
    await registerPropietario(PROPIETARIO, '1.2.3.4', 'test');
    expect(enviado()).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
