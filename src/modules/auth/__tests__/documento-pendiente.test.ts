import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// GET /auth/me: `documento_pendiente` (H43, registro liviano). Solo para el
// solicitante; la ficha en `solicitantes` manda sobre `perfiles` (misma fuente
// que «Mi cuenta»), y sin ficha cae a perfiles.
// ============================================================

const { mockPerfil, mockFicha, mockPago, mockNotificar, mockEstudiosCount } = vi.hoisted(() => ({
  mockPerfil: vi.fn(),
  mockFicha: vi.fn(),
  // Señal de pago del estudio (pago.guard): null = sin pago completado.
  mockPago: vi.fn(async (): Promise<{ data: unknown; error: unknown }> => ({ data: null, error: null })),
  mockNotificar: vi.fn(async (..._a: unknown[]) => undefined),
  // Estudios en curso o completados de sus expedientes (DOCUMENTO_BLOQUEADO_POR_ESTUDIO).
  mockEstudiosCount: vi.fn(async (): Promise<{ count: number; error: unknown }> => ({ count: 0, error: null })),
}));

vi.mock('@/lib/supabase', () => {
  const ficha = { eq: () => ficha, order: () => ficha, limit: () => ficha, maybeSingle: () => mockFicha() };
  const exps = { eq: () => exps, is: async () => ({ data: [{ id: 'exp-1' }], error: null }) };
  const pagos = { eq: () => pagos, limit: () => pagos, maybeSingle: () => mockPago() };
  const estudios: { in: (c: string) => unknown } = { in: (c: string) => (c === 'estado' ? mockEstudiosCount() : estudios) };
  return {
    supabaseAuth: { auth: {} },
    supabase: {
      from: (t: string) => ({
        select: () =>
          t === 'solicitantes' ? ficha : t === 'expedientes' ? exps : t === 'pagos' ? pagos : t === 'estudios' ? estudios : { eq: () => ({ single: () => mockPerfil() }) },
      }),
    },
  };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: {} }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/email', () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ resolveRolMiembro: vi.fn(async () => null) }));
vi.mock('@/modules/users/users.service', () => ({ listOperators: vi.fn(async () => [{ id: 'op-1' }]) }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: mockNotificar }));

import { getProfile, updateMyProfile } from '../auth.service';

const perfil = (rol: string, numero_documento: string | null) => ({
  data: {
    id: 'u1', nombre: 'Ana', apellido: 'Gómez', rol, estado: 'activo', telefono: '300',
    tipo_documento: numero_documento ? 'cc' : null, numero_documento, created_at: 'x', updated_at: 'x',
  },
  error: null,
});
const ficha = (numero_documento: string) => ({ data: { id: 's1', tipo_documento: 'cc', numero_documento } });

beforeEach(() => vi.clearAllMocks());

describe('getProfile · documento_pendiente', () => {
  it('registro liviano: ficha con numero_documento vacío → pendiente', async () => {
    mockPerfil.mockResolvedValue(perfil('solicitante', null));
    mockFicha.mockResolvedValue(ficha(''));
    expect(await getProfile('u1', 'a@b.co', 'solicitante')).toMatchObject({ documento_pendiente: true });
  });

  it('el gestor escribió el documento en la ficha (perfiles vacío) → no pendiente', async () => {
    mockPerfil.mockResolvedValue(perfil('solicitante', null));
    mockFicha.mockResolvedValue(ficha('1020304050'));
    expect(await getProfile('u1', 'a@b.co', 'solicitante')).toMatchObject({ documento_pendiente: false });
  });

  it('sin ficha cae a perfiles; también sin rol de sesión (refresh)', async () => {
    mockPerfil.mockResolvedValue(perfil('solicitante', '1020304050'));
    mockFicha.mockResolvedValue({ data: null });
    expect(await getProfile('u1', 'a@b.co')).toMatchObject({ documento_pendiente: false });
    expect(mockFicha).toHaveBeenCalledTimes(1);
  });

  it('otros roles no traen el campo ni consultan la ficha', async () => {
    mockPerfil.mockResolvedValue(perfil('propietario', null));
    const r = await getProfile('u1', 'a@b.co', 'propietario');
    expect(r).not.toHaveProperty('documento_pendiente');
    expect(mockFicha).not.toHaveBeenCalled();
  });
});

describe('updateMyProfile · Adenda de precios §6.1', () => {
  it('el solicitante completa su documento como NIT → 409 ESTUDIO_NO_AFIANZABLE', async () => {
    mockPerfil.mockResolvedValue({ data: { rol: 'solicitante', tipo_documento: null, numero_documento: null }, error: null });
    mockFicha.mockResolvedValue(ficha(''));
    await expect(updateMyProfile('u1', { tipo_documento: 'nit', numero_documento: '900123456' })).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'ESTUDIO_NO_AFIANZABLE',
      message: expect.stringContaining('No se generó ningún cobro'),
    });
    expect(mockNotificar).not.toHaveBeenCalled();
  });

  // Revisión 2026-09-29, M6: el estudio ya estaba pagado (gestor o cupo).
  it('con la evaluación ya pagada no dice «sin cobro» y avisa a Cofianza la devolución', async () => {
    mockPerfil.mockResolvedValue({ data: { rol: 'solicitante', tipo_documento: null, numero_documento: null }, error: null });
    mockFicha.mockResolvedValue(ficha(''));
    mockPago.mockResolvedValueOnce({ data: { id: 'pago-1' }, error: null });
    const err = await updateMyProfile('u1', { tipo_documento: 'nit', numero_documento: '900123456' }).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409, errorCode: 'ESTUDIO_NO_AFIANZABLE', details: { motivo: 'persona_juridica', ya_cobrado: true } });
    expect(err.message).not.toContain('No se generó ningún cobro');
    expect(err.message).toContain('Cofianza revisará la devolución');
    expect(mockNotificar).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'op-1', tipo: 'estudio.devolucion_por_revisar', link: '/expedientes/exp-1' }),
    );
    // El reintento repite el mensaje, pero no vuelve a escribir a los operadores.
    mockPago.mockResolvedValueOnce({ data: { id: 'pago-1' }, error: null });
    const otra = await updateMyProfile('u1', { tipo_documento: 'nit', numero_documento: '900123456' }).catch((e) => e);
    expect(otra.message).toContain('Cofianza revisará la devolución');
    expect(mockNotificar).toHaveBeenCalledTimes(1);
  });

  // Con la evaluación ya consultada el pago se consumió: no hay devolución que avisar.
  it('con un estudio en curso o completado bloquea el cambio sin hablar de devolución', async () => {
    mockPerfil.mockResolvedValue({ data: { rol: 'solicitante', tipo_documento: null, numero_documento: null }, error: null });
    mockFicha.mockResolvedValue(ficha(''));
    mockPago.mockResolvedValueOnce({ data: { id: 'pago-1' }, error: null });
    mockEstudiosCount.mockResolvedValueOnce({ count: 1, error: null });
    await expect(updateMyProfile('u1', { tipo_documento: 'nit', numero_documento: '900123456' })).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'DOCUMENTO_BLOQUEADO_POR_ESTUDIO',
    });
    expect(mockNotificar).not.toHaveBeenCalled();
  });
});
