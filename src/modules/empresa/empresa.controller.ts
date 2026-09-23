import type { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import { getCompany, setCompany, type CompanyInfo } from '@/lib/companyConfig';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import type { UpdateEmpresaInput } from './empresa.schema';

export async function get(_req: Request, res: Response) {
  const data = await getCompany();
  sendSuccess(res, data);
}

export async function update(req: Request, res: Response) {
  const body = req.body as UpdateEmpresaInput;
  const { antes, despues } = await setCompany(body);
  // Solo lo que cambió, con su valor anterior: la web manda siempre todos los
  // campos, así que la lista de claves no decía nada.
  const cambios = Object.fromEntries(
    (Object.keys(body) as Array<keyof CompanyInfo>)
      .filter((k) => antes[k] !== despues[k])
      .map((k) => [k, { antes: antes[k], despues: despues[k] }]),
  );
  if (Object.keys(cambios).length > 0) {
    logAudit({
      usuarioId: req.user!.id,
      accion: AUDIT_ACTIONS.CONFIG_CHANGED,
      entidad: AUDIT_ENTITIES.CONFIG,
      entidadId: 'empresa',
      detalle: { cambios },
      ip: req.ip,
    });
  }
  sendSuccess(res, despues);
}
