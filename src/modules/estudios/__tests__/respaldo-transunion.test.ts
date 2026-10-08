import { describe, it, expect } from 'vitest';
import { admiteReconsultaSinCentrales, debePasarATransUnion, transUnionNoConsulta } from '../decision';

// Revisión 2026-10-08 (B1-1, B1-2, B1-3): respaldo de TransUnion (Adenda 1 §2.3)
// y reconsulta del caso L (Política §14).

const base = {
  motorDecide: true,
  proveedor: 'datacredito',
  centralCaida: null,
  tipoDocumento: 'cc',
  proveedorNoDisponible: false,
  errorDelDato: false,
  dejoReferencia: false,
};

describe('debePasarATransUnion', () => {
  it('caída, credenciales o error genérico de DataCrédito pasan a TransUnion', () => {
    expect(debePasarATransUnion({ ...base, proveedorNoDisponible: true })).toBe(true);
    expect(debePasarATransUnion(base)).toBe(true); // PROVIDER_AUTH_ERROR, 403 de IP, otros 4xx
  });
  it('errores del dato o de la autorización no pasan', () => {
    expect(debePasarATransUnion({ ...base, errorDelDato: true })).toBe(false);
  });
  it('con consulta ya cobrada solo pasa una caída real', () => {
    expect(debePasarATransUnion({ ...base, dejoReferencia: true })).toBe(false);
    expect(debePasarATransUnion({ ...base, dejoReferencia: true, proveedorNoDisponible: true })).toBe(true);
  });
  it('una sola vez, solo desde DataCrédito y con el motor encendido', () => {
    expect(debePasarATransUnion({ ...base, centralCaida: 'datacredito' })).toBe(false);
    expect(debePasarATransUnion({ ...base, proveedor: 'transunion' })).toBe(false);
    expect(debePasarATransUnion({ ...base, motorDecide: false })).toBe(false);
  });
  it('PPT y PEP no van a TransUnion', () => {
    expect(debePasarATransUnion({ ...base, proveedorNoDisponible: true, tipoDocumento: 'ppt' })).toBe(false);
    expect(debePasarATransUnion({ ...base, tipoDocumento: 'PEP' })).toBe(false);
    expect(transUnionNoConsulta('ce')).toBe(false);
  });
});

describe('admiteReconsultaSinCentrales', () => {
  const casoL = {
    userRol: 'operador_analista',
    estado: 'completado',
    resultado: 'condicionado',
    score: null,
    expedienteEstado: 'condicionado',
    cascada: { centrales_consultadas: [], apis_fallidas: ['datacredito', 'transunion'] },
  };
  it('el analista reconsulta el caso L en revisión', () => {
    expect(admiteReconsultaSinCentrales(casoL)).toBe(true);
    expect(admiteReconsultaSinCentrales({ ...casoL, userRol: 'administrador' })).toBe(true);
  });
  it('ni la inmobiliaria, ni un condicionado con datos del buró, ni un caso ya decidido', () => {
    expect(admiteReconsultaSinCentrales({ ...casoL, userRol: 'inmobiliaria' })).toBe(false);
    expect(admiteReconsultaSinCentrales({ ...casoL, cascada: { centrales_consultadas: ['datacredito'], apis_fallidas: [] } })).toBe(false);
    expect(admiteReconsultaSinCentrales({ ...casoL, score: 72 })).toBe(false);
    expect(admiteReconsultaSinCentrales({ ...casoL, expedienteEstado: 'aprobado' })).toBe(false);
  });
});
