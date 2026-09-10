import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// Builder encadenable que registra los filtros aplicados.
const mockLlamadas: { tabla: string; in: Array<[string, unknown]>; consultada: boolean } = { tabla: '', in: [], consultada: false };
vi.mock('@/lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit', 'eq', 'gte', 'lte', 'ilike']) builder[m] = () => builder;
  builder.in = (col: string, vals: unknown) => {
    mockLlamadas.in.push([col, vals]);
    return builder;
  };
  builder.then = (resolve: (v: unknown) => unknown) => {
    mockLlamadas.consultada = true;
    return resolve({ data: [], error: null });
  };
  return {
    supabase: {
      from: (tabla: string) => {
        mockLlamadas.tabla = tabla;
        return builder;
      },
    },
  };
});
const mockScope = { expedientes: null as string[] | null, inmuebles: null as string[] | null };
vi.mock('@/lib/tenantScope', () => ({
  resolveAllowedExpedienteIds: async () => mockScope.expedientes,
  resolveAllowedInmuebleIds: async () => mockScope.inmuebles,
}));
vi.mock('../export.service', () => ({
  generateCSV: () => ({ buffer: Buffer.from(''), contentType: 'text/csv', filename: 'x.csv', truncated: false, totalRows: 0 }),
  generateXLSX: async () => ({ buffer: Buffer.from(''), contentType: 'x', filename: 'x.xlsx', truncated: false, totalRows: 0 }),
}));
vi.mock('@/modules/reportes/reportes.service', () => ({}));

import { exportExpedientes, exportInmuebles } from '../export.controller';

function req(rol: string): Request {
  return { user: { id: 'u1', rol }, query: {}, validatedQuery: {} } as unknown as Request;
}
const res = { set: vi.fn(), send: vi.fn() } as unknown as Response;

describe('exportaciones con scoping de tenant', () => {
  beforeEach(() => {
    mockLlamadas.in = [];
    mockLlamadas.consultada = false;
  });

  it('una inmobiliaria solo exporta los estudios de su cartera', async () => {
    mockScope.expedientes = ['e1', 'e2'];
    await exportExpedientes(req('inmobiliaria'), res);
    expect(mockLlamadas.in).toEqual([['id', ['e1', 'e2']]]);
  });

  it('un rol sin estudios visibles recibe un archivo vacío sin consultar la base', async () => {
    mockScope.expedientes = [];
    await exportExpedientes(req('solicitante'), res);
    expect(mockLlamadas.consultada).toBe(false);
  });

  it('los roles internos no llevan filtro', async () => {
    mockScope.expedientes = null;
    await exportExpedientes(req('administrador'), res);
    expect(mockLlamadas.in).toEqual([]);
  });

  it('los inmuebles también se filtran por la cartera del usuario', async () => {
    mockScope.inmuebles = ['i1'];
    await exportInmuebles(req('propietario'), res);
    expect(mockLlamadas.in).toEqual([['id', ['i1']]]);
  });
});
