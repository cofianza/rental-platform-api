import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

// ============================================================
// Tope de registros por IP (5 por hora, uno solo para los dos formularios): la
// validación va antes del tope, así un formulario mal llenado no gasta cupo y
// todos los válidos sí, también los que terminan en error (409 de correo o NIT).
// Con el tope primero, cinco intentos con un dato mal escrito dejaban a la
// persona una hora sin poder registrarse.
// ============================================================

vi.mock('@/lib/supabase', () => ({ supabase: {}, supabaseAuth: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { NODE_ENV: 'test', RATE_LIMIT_MAX: 1000 } }));
vi.mock('@/config/env', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../registration.service', async () => {
  const { AppError } = await import('@/lib/errors');
  return {
    registerPropietario: vi.fn(async () => ({ message: 'Registro exitoso.' })),
    registerInmobiliaria: vi.fn(async () => {
      throw AppError.conflict('Ya hay una inmobiliaria registrada con este NIT.', 'NIT_ALREADY_EXISTS');
    }),
  };
});

import registrationRouter from '../registration.routes';
import { errorHandler } from '@/middleware/errorHandler';

let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/auth/register', registrationRouter);
  app.use(errorHandler);
  await new Promise<void>((ok) => {
    server = app.listen(0, '127.0.0.1', () => ok());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/register`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const enviar = (formulario: 'propietario' | 'inmobiliaria', body: Record<string, unknown>) =>
  fetch(`${base}/${formulario}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.status);

const comunes = {
  email: 'ana@ejemplo.co',
  telefono: '+57 3001112233',
  password: 'Secreta123',
  confirm_password: 'Secreta123',
  accept_terms: true,
  accept_data_treatment: true,
};
const PROPIETARIO = { ...comunes, nombre: 'Ana', apellido: 'Paz', tipo_documento: 'cc', numero_documento: '1040567890' };
const INMOBILIARIA = {
  ...comunes,
  razon_social: 'Inmobiliaria Norte S.A.S.',
  nit: '900123456-8',
  direccion_comercial: 'Carrera 43A # 1-50',
  ciudad: 'Medellín',
  nombre_representante_nombre: 'Luis',
  nombre_representante_apellido: 'Gómez',
};

describe('POST /auth/register/(propietario|inmobiliaria) — tope por IP', () => {
  it('los inválidos no gastan cupo; los válidos sí, aunque terminen en error', async () => {
    // Más intentos inválidos que el tope, en los dos formularios: todos reciben su 400.
    for (let i = 0; i < 6; i++) expect(await enviar('propietario', { ...PROPIETARIO, telefono: '300' })).toBe(400);
    for (let i = 0; i < 6; i++) expect(await enviar('inmobiliaria', { ...INMOBILIARIA, nit: '900123456' })).toBe(400);

    // Los 5 válidos sí cuentan, entre los dos formularios y aunque el servicio responda 409.
    for (let i = 0; i < 3; i++) expect(await enviar('propietario', PROPIETARIO)).toBe(201);
    for (let i = 0; i < 2; i++) expect(await enviar('inmobiliaria', INMOBILIARIA)).toBe(409);
    expect(await enviar('propietario', PROPIETARIO)).toBe(429);
    expect(await enviar('inmobiliaria', INMOBILIARIA)).toBe(429);

    // Con el cupo agotado, un formulario mal llenado sigue viendo qué debe corregir.
    expect(await enviar('propietario', { ...PROPIETARIO, telefono: '300' })).toBe(400);
  });
});
