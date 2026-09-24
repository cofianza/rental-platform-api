import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Soportes del condicionado: el estudio 'con_coarrendatario' (se crea cuando
// el invitado acepta, despues del del titular) no puede pasar a ser el
// "activo". Si pasaba, los soportes del titular dejaban de listarse y las
// cargas nuevas quedaban colgadas del estudio del co-arrendatario.
// ============================================================

const { ops, queues, mockFrom } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'in', 'order']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.single = async () => next(table);
    chain.maybeSingle = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown) => Promise.resolve(next(table)).then(resolve);
    return chain;
  };
  return { ops, queues, mockFrom: vi.fn((t: string) => chainFor(t)) };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (t: string) => mockFrom(t),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
  },
  supabaseAuth: {},
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: vi.fn(async () => undefined) }));
const { mockNotificarUsuario, mockNotificarResponsable } = vi.hoisted(() => ({
  mockNotificarUsuario: vi.fn(async (_: Record<string, unknown>) => undefined),
  mockNotificarResponsable: vi.fn(async (_: Record<string, unknown>) => undefined),
}));
vi.mock('../../notificaciones/notificaciones.service', () => ({
  notificarUsuario: mockNotificarUsuario,
  notificarResponsableExpediente: mockNotificarResponsable,
}));
const mockEnviarCorreoEnlace = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('@/modules/orchestrator/orchestrator.emails', () => ({ sendResponsableAsignadoEmail: mockEnviarCorreoEnlace }));
vi.mock('@/modules/users/users.service', () => ({
  listOperators: vi.fn(async () => [{ id: 'analista-1' }, { id: 'analista-2' }]),
}));

import {
  listarSoportes,
  getContextoDocumentosPublico,
  confirmarSoporte,
  confirmarSoportePublico,
  emitirTokenDocumentos,
  enviarEnlaceDocumentos,
} from '../expediente-soportes.service';

const EXP = '550e8400-e29b-41d4-a716-446655440000';
const TITULAR = '880e8400-e29b-41d4-a716-446655440000';
const COA = '990e8400-e29b-41d4-a716-446655440000';

// El del co-arrendatario es el mas reciente: es justo el caso que fallaba.
const estudios = [
  { id: TITULAR, created_at: '2026-09-01T10:00:00Z', tipo: 'individual' },
  { id: COA, created_at: '2026-09-05T10:00:00Z', tipo: 'con_coarrendatario' },
];

const estudioListado = () =>
  ops.find((o) => o.table === 'estudios_documentos_soporte' && o.method === 'eq' && o.args[0] === 'estudio_id')?.args[1];

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  mockNotificarUsuario.mockClear();
  mockNotificarResponsable.mockClear();
});

describe('soportes del condicionado con co-arrendatario', () => {
  it('el panel lista los soportes del estudio del titular', async () => {
    queues.set('expedientes', [
      { data: { id: EXP, estado: 'condicionado', creado_por: null, inmuebles: null, solicitantes: null, estudios }, error: null },
    ]);

    await listarSoportes(EXP, 'analista-1', 'operador_analista');

    const sel = ops.find((o) => o.table === 'expedientes' && o.method === 'select');
    expect(String(sel?.args[0])).toContain('estudios(id, created_at, tipo)');
    expect(estudioListado()).toBe(TITULAR);
  });

  it('el enlace publico tambien usa el estudio del titular', async () => {
    queues.set('expedientes', [
      { data: { id: EXP, estado: 'condicionado', token_documentos_expiracion: null, inmuebles: null, solicitantes: null, estudios }, error: null },
    ]);

    await getContextoDocumentosPublico('tok');

    expect(estudioListado()).toBe(TITULAR);
  });

  it('solo con el estudio del co-arrendatario no hay evaluacion del titular', async () => {
    queues.set('expedientes', [
      { data: { id: EXP, estado: 'condicionado', creado_por: null, inmuebles: null, solicitantes: null, estudios: [estudios[1]] }, error: null },
    ]);

    await expect(listarSoportes(EXP, 'analista-1', 'operador_analista')).rejects.toMatchObject({ errorCode: 'SIN_ESTUDIO' });
  });
});

// ============================================================
// P18: el enlace del prospecto también sirve para invitar a su co-arrendatario
// ============================================================

describe('enlace del prospecto — co-arrendatario (P18)', () => {
  const expediente = (estado = 'condicionado') => ({
    data: { id: EXP, estado, token_documentos_expiracion: null, inmuebles: null, solicitantes: null, estudios },
    error: null,
  });
  const intencion = { nombre: 'Luis', apellido: 'Gómez', email: 'luis@correo.co' };

  it('sin invitación: puede invitar, prellenado con lo que declaró al autorizar', async () => {
    queues.set('expedientes', [expediente()]);
    queues.set('autorizacion_perfil_prospecto', [{ data: { coarrendatario_intencion: intencion }, error: null }]);

    const ctx = await getContextoDocumentosPublico('tok');

    // Solo nombre y apellido: nunca el correo ni el WhatsApp del tercero.
    expect(ctx.coarrendatario).toEqual({ puede_invitar: true, invitado: null, sugerido: { nombre: 'Luis', apellido: 'Gómez' } });
  });

  it('con una invitación activa: solo su nombre y en qué va, sin prellenado', async () => {
    queues.set('expedientes', [expediente()]);
    queues.set('expediente_coarrendatarios', [{ data: { nombre: 'Luis', estado: 'aceptado' }, error: null }]);
    queues.set('autorizacion_perfil_prospecto', [{ data: { coarrendatario_intencion: intencion }, error: null }]);

    const ctx = await getContextoDocumentosPublico('tok');

    expect(ctx.coarrendatario).toEqual({
      puede_invitar: false,
      invitado: { nombre: 'Luis', estado: 'aceptado', vencida: false },
      sugerido: null,
    });
  });

  it('invitación pendiente que pasó su plazo: vencida', async () => {
    queues.set('expedientes', [expediente()]);
    queues.set('expediente_coarrendatarios', [
      { data: { nombre: 'Luis', estado: 'pendiente_aceptacion', token_expiracion: '2020-01-01T00:00:00Z' }, error: null },
    ]);

    expect((await getContextoDocumentosPublico('tok')).coarrendatario.invitado).toEqual({
      nombre: 'Luis',
      estado: 'pendiente_aceptacion',
      vencida: true,
    });
  });

  it('fuera de condicionado no se puede invitar', async () => {
    queues.set('expedientes', [expediente('aprobado')]);

    expect((await getContextoDocumentosPublico('tok')).coarrendatario.puede_invitar).toBe(false);
  });

  it('el correo automático del condicionado reutiliza el enlace vigente (no deja muerto el que mandó el gestor)', async () => {
    const vigente = 'b'.repeat(64);
    queues.set('expedientes', [
      { data: { token_documentos: vigente, token_documentos_expiracion: '2099-01-01T00:00:00Z' }, error: null },
      { data: null, error: null },
    ]);

    expect(await emitirTokenDocumentos(EXP)).toBe(vigente);
    const update = ops.find((o) => o.table === 'expedientes' && o.method === 'update');
    expect((update!.args[0] as { token_documentos: string }).token_documentos).toBe(vigente);
  });

  it('el envío explícito del gestor ROTA el enlace: el anterior deja de servir', async () => {
    const viejo = 'b'.repeat(64);
    queues.set('expedientes', [
      { data: { id: EXP, estado: 'condicionado', creado_por: null, inmuebles: null, solicitantes: null, estudios }, error: null },
      { data: { solicitantes: { nombre: 'Ana', apellido: 'Pérez', email: 'ana@correo.co' }, inmuebles: { direccion: 'Cra 7' } }, error: null },
      // Si se leyera el token vigente, este sería el que se reusa.
      { data: { token_documentos: viejo, token_documentos_expiracion: '2099-01-01T00:00:00Z' }, error: null },
    ]);

    await enviarEnlaceDocumentos(EXP, 'analista-1', 'operador_analista');

    const update = ops.find((o) => o.table === 'expedientes' && o.method === 'update');
    const nuevo = (update!.args[0] as { token_documentos: string }).token_documentos;
    expect(nuevo).toMatch(/^[a-f0-9]{64}$/);
    expect(nuevo).not.toBe(viejo);
    expect(mockEnviarCorreoEnlace).toHaveBeenCalledWith(expect.objectContaining({ link: `/cargar-documentos/${nuevo}` }));
  });

  it('si el correo no sale después de rotar, responde el error (el enlace anterior ya no sirve)', async () => {
    mockEnviarCorreoEnlace.mockRejectedValueOnce(new Error('resend caído'));
    queues.set('expedientes', [
      { data: { id: EXP, estado: 'condicionado', creado_por: null, inmuebles: null, solicitantes: null, estudios }, error: null },
      { data: { solicitantes: { nombre: 'Ana', apellido: 'Pérez', email: 'ana@correo.co' }, inmuebles: { direccion: 'Cra 7' } }, error: null },
    ]);

    await expect(enviarEnlaceDocumentos(EXP, 'analista-1', 'operador_analista')).rejects.toMatchObject({
      statusCode: 502,
      errorCode: 'CORREO_NO_ENVIADO',
      message: expect.stringContaining('el enlace anterior ya no sirve'),
    });
  });

  it('vencido, uno nuevo', async () => {
    queues.set('expedientes', [
      { data: { token_documentos: 'b'.repeat(64), token_documentos_expiracion: '2020-01-01T00:00:00Z' }, error: null },
      { data: null, error: null },
    ]);

    const token = await emitirTokenDocumentos(EXP);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(token).not.toBe('b'.repeat(64));
  });
});

// ============================================================
// En el condicionado decide un analista de Cofianza: un soporte nuevo le
// tiene que llegar. Antes solo se avisaba al dueño del inmueble.
// ============================================================

describe('soporte nuevo del solicitante', () => {
  const PROP = 'prop-1';
  const input = {
    storage_key: `expedientes/${EXP}/soportes/a.pdf`,
    nombre_original: 'a.pdf',
    tipo_mime: 'application/pdf' as const,
    tamano_bytes: 100,
    proposito: 'extractos_bancarios' as const,
  };
  const avisados = () => mockNotificarUsuario.mock.calls.map((c) => c[0]);

  it('por el enlace publico avisa a los analistas, al dueño y al responsable', async () => {
    queues.set('expedientes', [
      {
        data: { id: EXP, estado: 'condicionado', token_documentos_expiracion: null, inmuebles: { propietario_id: PROP, direccion: 'Cra 7', ciudad: null }, solicitantes: null, estudios },
        error: null,
      },
    ]);
    queues.set('estudios_documentos_soporte', [{ data: { id: 'doc-1', proposito: 'extractos_bancarios', nombre_original: 'a.pdf' }, error: null }]);

    await confirmarSoportePublico('tok', input);

    await vi.waitFor(() => expect(mockNotificarResponsable).toHaveBeenCalled());
    const analistas = avisados().filter((a) => a.tipo === 'estudio.revision_manual').map((a) => a.userId);
    expect(analistas).toEqual(['analista-1', 'analista-2']);
    const alDueno = avisados().find((a) => a.userId === PROP);
    expect(alDueno?.mensaje).not.toContain('antes de aprobar');
    expect(mockNotificarResponsable.mock.calls[0][0]).toMatchObject({ expedienteId: EXP, excluirPerfilId: PROP });
  });

  it('el solicitante con cuenta tambien avisa a los analistas', async () => {
    queues.set('expedientes', [
      { data: { id: EXP, estado: 'condicionado', creado_por: null, inmuebles: { propietario_id: PROP }, solicitantes: { creado_por: 'sol-1' }, estudios }, error: null },
    ]);
    queues.set('estudios_documentos_soporte', [
      { data: { id: 'doc-2', proposito: 'extractos_bancarios', nombre_original: 'a.pdf', storage_key: input.storage_key }, error: null },
    ]);

    await confirmarSoporte(EXP, 'sol-1', 'solicitante', input);

    await vi.waitFor(() => expect(mockNotificarResponsable).toHaveBeenCalled());
    expect(avisados().filter((a) => a.tipo === 'estudio.revision_manual')).toHaveLength(2);
  });
});
