/**
 * Bitácora de los datos de la empresa: guarda qué campo cambió y su valor
 * anterior (la web manda siempre los seis campos).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { setCompany, logAudit } = vi.hoisted(() => ({ setCompany: vi.fn(), logAudit: vi.fn() }));
vi.mock('@/lib/companyConfig', () => ({ getCompany: vi.fn(), setCompany }));
vi.mock('@/lib/auditLog', () => ({
  logAudit,
  AUDIT_ACTIONS: { CONFIG_CHANGED: 'config_changed' },
  AUDIT_ENTITIES: { CONFIG: 'config' },
}));
vi.mock('@/utils/response', () => ({ sendSuccess: vi.fn() }));

import { update } from '../empresa.controller';

const base = {
  name: 'Cofianza S.A.S.',
  nit: '901.038.122-7',
  address: 'Calle 1',
  phone: '300',
  email: 'hola@cofianza.co',
  website: 'cofianza.co',
  certificateValidityDays: 60,
};
const req = (body: Record<string, unknown>) =>
  ({ body, user: { id: 'u1' }, ip: '1.1.1.1' }) as unknown as Request;

describe('empresa.update — bitácora con antes y después', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registra solo los campos que cambiaron, con su valor anterior', async () => {
    const body = { ...base, nit: '902.038.122-7' };
    setCompany.mockResolvedValue({ antes: base, despues: { ...base, nit: '902.038.122-7' } });

    await update(req(body), {} as Response);

    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0].detalle).toEqual({
      cambios: { nit: { antes: '901.038.122-7', despues: '902.038.122-7' } },
    });
  });

  it('no escribe en la bitácora si nada cambió', async () => {
    setCompany.mockResolvedValue({ antes: base, despues: base });

    await update(req({ ...base }), {} as Response);

    expect(logAudit).not.toHaveBeenCalled();
  });
});
