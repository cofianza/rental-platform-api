/**
 * Canje de la invitación de un arrendatario: el evento de timeline.
 *
 * vincularExpedienteExterno escribía usuario_id = id de `solicitantes`, pero
 * eventos_timeline.usuario_id tiene FK a perfiles: el insert fallaba en
 * silencio y el estudio no mostraba cuándo se vinculó el arrendatario.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queues, inserts, mockLoggerError } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  return {
    queues: new Map<string, Res[]>(),
    inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
    mockLoggerError: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const next = async () => queues.get(table)?.shift() ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'eq']) chain[m] = () => chain;
    chain.insert = (payload: Record<string, unknown>) => {
      inserts.push({ table, payload });
      return chain;
    };
    chain.single = next;
    chain.maybeSingle = next;
    chain.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => next().then(ok, ko);
    return chain;
  };
  return { supabase: { from: (t: string) => chainFor(t) } };
});
vi.mock('@/config/env', () => ({ env: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLoggerError, debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('../../orchestrator/orchestrator.emails', () => ({ sendExpedienteInvitacionEmail: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ assertInmuebleAccess: vi.fn(), esMiembroNoOwnerDeOrg: vi.fn() }));

import { vincularExpedienteExterno } from '../expediente-externo.service';

const EXP = { id: 'exp-1', numero: 'EXP-1', estado: 'borrador', solicitante_id: null, token_invitacion: 'tok', email_invitacion: 'a@b.co' };

beforeEach(() => {
  queues.clear();
  inserts.length = 0;
  vi.clearAllMocks();
  queues.set('expedientes', [
    { data: EXP, error: null },
    { data: null, error: null },
    { data: { ...EXP, solicitante_id: 'sol-1', estudio_habilitado: true }, error: null },
  ]);
});

describe('vincularExpedienteExterno: evento de timeline', () => {
  it('usuario_id es el perfil que canjea; el solicitante va en la metadata', async () => {
    await vincularExpedienteExterno('tok', 'sol-1', 'perfil-1');

    const ev = inserts.find((i) => i.table === 'eventos_timeline')?.payload;
    expect(ev?.usuario_id).toBe('perfil-1');
    expect(ev?.metadata).toMatchObject({ solicitante_id: 'sol-1', via: 'invitacion_externa' });
  });

  it('si el insert falla, se registra en el log y el canje sigue', async () => {
    queues.set('eventos_timeline', [{ data: null, error: { message: 'fk' } }]);

    await expect(vincularExpedienteExterno('tok', 'sol-1', 'perfil-1')).resolves.toMatchObject({ id: 'exp-1' });
    expect(mockLoggerError).toHaveBeenCalled();
  });
});
