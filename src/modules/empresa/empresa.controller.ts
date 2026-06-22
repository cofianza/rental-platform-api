import type { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import { getCompany, setCompany } from '@/lib/companyConfig';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import type { UpdateEmpresaInput } from './empresa.schema';

export async function get(_req: Request, res: Response) {
  const data = await getCompany();
  sendSuccess(res, data);
}

export async function update(req: Request, res: Response) {
  const data = await setCompany(req.body as UpdateEmpresaInput);
  logAudit({
    usuarioId: req.user!.id,
    accion: AUDIT_ACTIONS.CONFIG_CHANGED,
    entidad: AUDIT_ENTITIES.CONFIG,
    entidadId: 'empresa',
    detalle: { campos: Object.keys(req.body as Record<string, unknown>) },
    ip: req.ip,
  });
  sendSuccess(res, data);
}
