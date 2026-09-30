/**
 * Enlace mágico del arrendatario invitado (H44): solo a correos con invitación,
 * sin revelar nada, sin cambiar roles, y el canje abre la sesión como el login.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const h = vi.hoisted(() => ({
  // Respuesta por tabla (o 'rpc'); lo no configurado responde vacío.
  resp: {} as Record<string, { data: unknown; error: unknown }>,
  ops: [] as Array<{ tabla: string; op: string; args: unknown[] }>,
  createUser: vi.fn(),
  generateLink: vi.fn(),
  verifyOtp: vi.fn(),
  signOut: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/supabase', () => {
  const chainFor = (tabla: string) => {
    const chain: Record<string, unknown> = {};
    for (const op of ['select', 'eq', 'ilike', 'not', 'is', 'in', 'limit', 'update', 'insert', 'order']) {
      chain[op] = (...args: unknown[]) => {
        h.ops.push({ tabla, op, args });
        return chain;
      };
    }
    const r = () => h.resp[tabla] ?? { data: null, error: null };
    chain.maybeSingle = async () => r();
    chain.single = async () => r();
    chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(r()).then(ok);
    return chain;
  };
  return {
    supabase: { from: (t: string) => chainFor(t), rpc: () => chainFor('rpc') },
    supabaseAuth: {
      auth: {
        admin: { createUser: h.createUser, generateLink: h.generateLink, signOut: h.signOut, deleteUser: vi.fn() },
        verifyOtp: h.verifyOtp,
      },
    },
  };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'https://web.test', NODE_ENV: 'production', RATE_LIMIT_MAX: 300 } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/email', () => ({ sendEnlaceMagicoEmail: h.sendEmail }));
vi.mock('../../registration/registration.service', () => ({ recordTermsAcceptance: vi.fn(async () => undefined) }));
vi.mock('../../notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn() }));
vi.mock('../../whatsapp', () => ({ enviarTemplate: vi.fn() }));

import { solicitarEnlaceMagico, verificarEnlaceMagico } from '../enlace-magico.service';
import { enlaceMagicoPorCorreoLimiter, enlaceMagicoPorIpLimiter } from '@/middleware/rateLimiter';
import { recordTermsAcceptance } from '../../registration/registration.service';

const EMAIL = 'Ana_R@Correo.co';
const datos = {
  nombre: 'Ana', apellido: 'Ruiz', telefono: '+57 3001234567', tipo_documento: 'cc' as const,
  numero_documento: '123456', accept_terms: true as const, accept_data_treatment: true as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.ops.length = 0;
  for (const k of Object.keys(h.resp)) delete h.resp[k];
  h.generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'abc123def456abc123' } }, error: null });
  h.sendEmail.mockResolvedValue(undefined);
});

describe('solicitarEnlaceMagico', () => {
  it('correo sin invitación: no busca cuenta, no crea nada ni genera enlace', async () => {
    h.resp.expedientes = { data: [], error: null };
    await expect(solicitarEnlaceMagico({ email: EMAIL, datos })).resolves.toBeUndefined();
    expect(h.createUser).not.toHaveBeenCalled();
    expect(h.generateLink).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
    // El correo va en minúsculas y con los comodines de ILIKE escapados.
    expect(h.ops.find((o) => o.op === 'ilike')?.args).toEqual(['email_invitacion', 'ana\\_r@correo.co']);
  });

  it('invitado sin cuenta y con sus datos: crea la cuenta sin contraseña como arrendatario y le manda el enlace', async () => {
    h.resp.expedientes = { data: [{ solicitante_id: null, token_invitacion: 't'.repeat(64) }], error: null };
    h.resp.rpc = { data: null, error: null };
    h.resp.solicitantes = { data: [], error: null };
    h.createUser.mockResolvedValue({ data: { user: { id: 'u-nuevo' } }, error: null });

    await solicitarEnlaceMagico({ email: EMAIL, datos }, '1.1.1.1', 'ua');

    const alta = h.createUser.mock.calls[0][0];
    expect(alta).toMatchObject({ email: 'ana_r@correo.co', email_confirm: true });
    expect(alta).not.toHaveProperty('password');
    const updPerfil = h.ops.find((o) => o.tabla === 'perfiles' && o.op === 'update');
    expect(updPerfil?.args[0]).toMatchObject({ rol: 'solicitante', estado: 'activo', registration_source: 'invitacion_externa' });
    expect(h.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'ana_r@correo.co' });
    expect(h.sendEmail).toHaveBeenCalledWith('ana_r@correo.co', 'https://web.test/auth/confirmar#token_hash=abc123def456abc123');
  });

  it('M7: al crear la cuenta no toma el documento ni registra la aceptación (aún no probó el correo)', async () => {
    h.resp.expedientes = { data: [{ solicitante_id: null, token_invitacion: 't'.repeat(64) }], error: null };
    h.resp.rpc = { data: null, error: null };
    h.createUser.mockResolvedValue({ data: { user: { id: 'u-nuevo' } }, error: null });

    await solicitarEnlaceMagico({ email: EMAIL, datos }, '1.1.1.1', 'ua');

    expect(h.createUser).toHaveBeenCalledOnce();
    const updPerfil = h.ops.find((o) => o.tabla === 'perfiles' && o.op === 'update');
    expect(updPerfil?.args[0]).not.toHaveProperty('numero_documento');
    const ficha = h.ops.find((o) => o.tabla === 'solicitantes' && o.op === 'insert');
    expect(ficha?.args[0]).toMatchObject({ numero_documento: '' });
    expect(ficha?.args[0]).not.toHaveProperty('tipo_documento');
    expect(recordTermsAcceptance).not.toHaveBeenCalled();
    expect(h.sendEmail).toHaveBeenCalledOnce();
  });

  it('sin cuenta y con la invitación ya aceptada o sin token: no crea cuenta', async () => {
    h.resp.expedientes = { data: [{ solicitante_id: null, token_invitacion: null }], error: null };
    h.resp.rpc = { data: null, error: null };
    await solicitarEnlaceMagico({ email: EMAIL, datos });
    expect(h.createUser).not.toHaveBeenCalled();
    expect(h.generateLink).not.toHaveBeenCalled();
  });

  it('invitado sin cuenta y sin datos: no crea cuenta ni manda enlace', async () => {
    h.resp.expedientes = { data: [{ solicitante_id: null, token_invitacion: 't'.repeat(64) }], error: null };
    await solicitarEnlaceMagico({ email: EMAIL });
    expect(h.createUser).not.toHaveBeenCalled();
    expect(h.generateLink).not.toHaveBeenCalled();
  });

  it('invitado con cuenta de otro rol: no le cambia el rol ni le manda enlace', async () => {
    h.resp.expedientes = { data: [{ solicitante_id: null, token_invitacion: 't'.repeat(64) }], error: null };
    h.resp.rpc = { data: { id: 'u-prop' }, error: null };
    h.resp.perfiles = { data: { rol: 'propietario', estado: 'activo' }, error: null };

    await solicitarEnlaceMagico({ email: EMAIL, datos });

    expect(h.createUser).not.toHaveBeenCalled();
    expect(h.ops.some((o) => o.op === 'update' || o.op === 'insert')).toBe(false);
    expect(h.generateLink).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('invitado con cuenta de arrendatario activa: solo le manda el enlace', async () => {
    h.resp.expedientes = { data: [{ solicitante_id: 's-1', token_invitacion: 't'.repeat(64) }], error: null };
    h.resp.rpc = { data: { id: 'u-sol' }, error: null };
    h.resp.perfiles = { data: { rol: 'solicitante', estado: 'activo' }, error: null };

    await solicitarEnlaceMagico({ email: EMAIL, datos });

    expect(h.createUser).not.toHaveBeenCalled();
    expect(h.sendEmail).toHaveBeenCalledOnce();
  });

  it('A1: arrendatario que ya aceptó la invitación (token en null) también recibe el enlace', async () => {
    h.resp.expedientes = { data: [{ solicitante_id: 's-1', token_invitacion: null }], error: null };
    h.resp.rpc = { data: { id: 'u-sol' }, error: null };
    h.resp.perfiles = { data: { rol: 'solicitante', estado: 'activo' }, error: null };

    await solicitarEnlaceMagico({ email: EMAIL });

    // La búsqueda de invitaciones no exige una pendiente.
    const filtros = h.ops.filter((o) => o.tabla === 'expedientes').map((o) => o.args[0]);
    expect(filtros).not.toContain('token_invitacion');
    expect(h.createUser).not.toHaveBeenCalled();
    expect(h.sendEmail).toHaveBeenCalledOnce();
  });
});

describe('verificarEnlaceMagico', () => {
  it('enlace válido: abre la sesión con la misma forma que el login', async () => {
    h.verifyOtp.mockResolvedValue({
      data: {
        user: { id: 'u-sol', email: 'ana@correo.co' },
        session: { access_token: 'at', refresh_token: 'rt', expires_at: 123 },
      },
      error: null,
    });
    h.resp.perfiles = { data: { rol: 'solicitante', estado: 'activo' }, error: null };

    const r = await verificarEnlaceMagico({ token_hash: 'abc123def456abc123' });

    expect(h.verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc123def456abc123', type: 'magiclink' });
    expect(r).toEqual({
      redirect: '/dashboard',
      user: { id: 'u-sol', email: 'ana@correo.co', rol: 'solicitante' },
      session: { access_token: 'at', refresh_token: 'rt', expires_at: 123 },
    });
  });

  it('con una invitación pendiente, lo devuelve a ella', async () => {
    h.verifyOtp.mockResolvedValue({
      data: { user: { id: 'u', email: 'ana@correo.co' }, session: { access_token: 'at', refresh_token: 'rt', expires_at: 1 } },
      error: null,
    });
    h.resp.perfiles = { data: { rol: 'solicitante', estado: 'activo' }, error: null };
    h.resp.expedientes = { data: { token_invitacion: 'f'.repeat(64) }, error: null };
    const r = await verificarEnlaceMagico({ token_hash: 'abc123def456abc123' });
    expect(r.redirect).toBe(`/invitacion/${'f'.repeat(64)}`);
  });

  it('M7: primer ingreso sin aceptación registrada: la registra con la IP y el navegador de quien verifica', async () => {
    h.verifyOtp.mockResolvedValue({
      data: { user: { id: 'u-nuevo', email: 'ana@correo.co' }, session: { access_token: 'at', refresh_token: 'rt', expires_at: 1 } },
      error: null,
    });
    h.resp.perfiles = { data: { rol: 'solicitante', estado: 'activo' }, error: null };
    await verificarEnlaceMagico({ token_hash: 'abc123def456abc123' }, '2.2.2.2', 'ua-buzon');
    expect(recordTermsAcceptance).toHaveBeenCalledWith('u-nuevo', '2.2.2.2', 'ua-buzon');
  });

  it('M7: si la aceptación ya estaba registrada, no la duplica', async () => {
    h.verifyOtp.mockResolvedValue({
      data: { user: { id: 'u-sol', email: 'ana@correo.co' }, session: { access_token: 'at', refresh_token: 'rt', expires_at: 1 } },
      error: null,
    });
    h.resp.perfiles = { data: { rol: 'solicitante', estado: 'activo' }, error: null };
    h.resp.terminos_aceptaciones = { data: { id: 'ta-1' }, error: null };
    await verificarEnlaceMagico({ token_hash: 'abc123def456abc123' }, '2.2.2.2', 'ua');
    expect(recordTermsAcceptance).not.toHaveBeenCalled();
  });

  it('cuenta que no es de arrendatario: cierra la sesión y responde el mismo 401 genérico', async () => {
    h.verifyOtp.mockResolvedValue({
      data: { user: { id: 'u-prop', email: 'p@b.co' }, session: { access_token: 'at', refresh_token: 'rt', expires_at: 1 } },
      error: null,
    });
    h.resp.perfiles = { data: { rol: 'propietario', estado: 'activo' }, error: null };
    await expect(verificarEnlaceMagico({ token_hash: 'abc123def456abc123' })).rejects.toMatchObject({
      statusCode: 401,
      errorCode: 'ENLACE_INVALIDO',
    });
    expect(h.signOut).toHaveBeenCalledWith('at');
    expect(recordTermsAcceptance).not.toHaveBeenCalled();
  });

  it('enlace usado, vencido o inválido: 401 ENLACE_INVALIDO', async () => {
    h.verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: { message: 'Token has expired or is invalid' } });
    await expect(verificarEnlaceMagico({ token_hash: 'abc123def456abc123' })).rejects.toMatchObject({
      statusCode: 401,
      errorCode: 'ENLACE_INVALIDO',
    });
  });

  it('cuenta desactivada: cierra la sesión recién abierta y responde 403', async () => {
    h.verifyOtp.mockResolvedValue({
      data: { user: { id: 'u', email: 'a@b.co' }, session: { access_token: 'at', refresh_token: 'rt', expires_at: 1 } },
      error: null,
    });
    h.resp.perfiles = { data: { rol: 'solicitante', estado: 'inactivo' }, error: null };
    await expect(verificarEnlaceMagico({ token_hash: 'abc123def456abc123' })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.signOut).toHaveBeenCalledWith('at');
  });
});

describe('límites del enlace mágico', () => {
  function pedir(limiter: typeof enlaceMagicoPorIpLimiter, email: string, ip: string): Promise<number> {
    return new Promise((resolve) => {
      const req = { body: { email }, ip, headers: {}, method: 'POST', app: { get: () => 1 } } as unknown as Request;
      const res = {
        statusCode: 200,
        setHeader: () => undefined,
        getHeader: () => undefined,
        append: () => undefined,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        send() {
          resolve(this.statusCode);
        },
        json() {
          resolve(this.statusCode);
        },
      } as unknown as Response;
      void limiter(req, res, (err?: unknown) => resolve(err ? 500 : 200));
    });
  }

  it('3 por hora a un mismo correo (sin importar mayúsculas ni la IP); otro correo sigue', async () => {
    const estados: number[] = [];
    for (const [i, e] of ['x@y.co', 'X@Y.co', ' x@y.co', 'x@y.co'].entries()) {
      estados.push(await pedir(enlaceMagicoPorCorreoLimiter, e, `198.51.100.${i}`));
    }
    expect(estados).toEqual([200, 200, 200, 429]);
    expect(await pedir(enlaceMagicoPorCorreoLimiter, 'otro@y.co', '198.51.100.9')).toBe(200);
  });

  it('10 por hora desde una misma IP', async () => {
    const estados: number[] = [];
    for (let i = 0; i < 11; i++) estados.push(await pedir(enlaceMagicoPorIpLimiter, `c${i}@y.co`, '203.0.113.50'));
    expect(estados.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(estados[10]).toBe(429);
  });
});
