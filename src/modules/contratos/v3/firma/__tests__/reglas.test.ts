import { describe, it, expect, vi } from 'vitest';

// Dependencias con efectos al importar (reglas.ts llega a firma-multiparte por
// mapTipoDocumentoToAuco/aucoDeriveCountry). `@/lib/auco` NO se mockea: sus
// funciones puras (normalizePhoneToInternational) son parte de lo que se prueba.
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), storage: {} }, supabaseAuth: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: { AUCO_SENDER_EMAIL: 'firma@cofianza.co' } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));

import {
  actualizarFirmantes,
  construirSignProfile,
  datosDeFirma,
  decidir,
  fechasDeFirma,
  mapEstadoFirmante,
  partesCompletas,
  sobreIdDeCustom,
  textoAvisoFirmaIncompleta,
  ultimaFirma,
  validarFirmantes,
  type FirmanteSobre,
  type ParteFirmante,
} from '../reglas';

// ============================================================
// Reglas puras de la firma V3 (Entrega 5): quién firma y en qué orden, qué
// significa lo que contesta Auco y cuándo se activa la fianza.
// ============================================================

const parte = (x: Partial<ParteFirmante> & Pick<ParteFirmante, 'id' | 'rol' | 'orden'>): ParteFirmante => ({
  nombre: 'Persona Uno',
  tipo_documento: 'cc',
  numero_documento: '100200300',
  email: `${x.rol}@ejemplo.co`,
  telefono: '3001112233',
  ...x,
});

const ARRENDATARIO = parte({ id: 'p1', rol: 'arrendatario', orden: 1, nombre: 'Ana Ruiz', telefono: '3001112233' });
const COARRENDATARIO = parte({ id: 'p2', rol: 'coarrendatario', orden: 2, nombre: 'Beto Díaz', telefono: '3004445566' });
const ARRENDADOR = parte({
  id: 'p3',
  rol: 'arrendador',
  orden: 3,
  nombre: 'Inmobiliaria Sur S.A.S.',
  tipo_documento: 'nit',
  numero_documento: '901234567',
  email: 'recaudo@sur.co',
  telefono: '3007778899',
  representante_legal_nombre: 'Caro Gómez',
  representante_legal_tipo_documento: 'cc',
  representante_legal_documento: '52123456',
});
const TRES = [ARRENDATARIO, COARRENDATARIO, ARRENDADOR];

describe('datosDeFirma', () => {
  it('el arrendador firma con el representante legal y su C.C., nunca con el NIT', () => {
    expect(datosDeFirma(ARRENDADOR)).toMatchObject({
      nombre: 'Caro Gómez',
      tipoDocumento: 'cc',
      documento: '52123456',
      email: 'recaudo@sur.co',
    });
    expect(datosDeFirma(ARRENDATARIO)).toMatchObject({ nombre: 'Ana Ruiz', documento: '100200300' });
  });
});

describe('validarFirmantes', () => {
  it('con datos completos y distintos no hay fallas', () => {
    expect(validarFirmantes(TRES)).toEqual([]);
  });

  it('teléfono repetido entre firmantes (Auco enruta el OTP por WhatsApp)', () => {
    const fallas = validarFirmantes([ARRENDATARIO, { ...COARRENDATARIO, telefono: '300 111 2233' }, ARRENDADOR]);
    expect(fallas).toHaveLength(1);
    expect(fallas[0]).toMatchObject({ rol: 'coarrendatario' });
    expect(fallas[0].motivo).toContain('+573001112233');
  });

  it('correo repetido', () => {
    const fallas = validarFirmantes([ARRENDATARIO, { ...COARRENDATARIO, email: 'ARRENDATARIO@ejemplo.co' }, ARRENDADOR]);
    expect(fallas.map((f) => f.rol)).toEqual(['coarrendatario']);
  });

  it('faltan datos: correo, celular, celular impresentable y documento del representante', () => {
    const fallas = validarFirmantes([
      { ...ARRENDATARIO, email: null },
      { ...COARRENDATARIO, telefono: '123' },
      { ...ARRENDADOR, representante_legal_documento: null },
    ]);
    expect(fallas.map((f) => f.rol)).toEqual(['arrendatario', 'coarrendatario', 'arrendador']);
    expect(fallas[1].motivo).toContain('no es un número válido');
  });
});

describe('partesCompletas', () => {
  it('arrendatario primero, arrendador último y órdenes 1..n', () => {
    expect(partesCompletas(TRES, 1)).toBe(true);
    expect(partesCompletas([ARRENDATARIO, { ...ARRENDADOR, orden: 2 }], 0)).toBe(true);
  });

  it('rechaza faltantes, sobrantes y órdenes con hueco', () => {
    expect(partesCompletas([ARRENDATARIO, ARRENDADOR], 1)).toBe(false);
    expect(partesCompletas(TRES, 0)).toBe(false);
    expect(partesCompletas([ARRENDATARIO, { ...COARRENDATARIO, orden: 4 }, ARRENDADOR], 1)).toBe(false);
    expect(partesCompletas([{ ...ARRENDADOR, orden: 1 }, { ...ARRENDATARIO, orden: 2 }], 0)).toBe(false);
  });
});

describe('construirSignProfile', () => {
  it('orden 1..n en el orden de firma, label y OTP por WhatsApp; sin Cofianza', () => {
    const perfiles = construirSignProfile([ARRENDADOR, ARRENDATARIO, COARRENDATARIO]);
    expect(perfiles.map((p) => [p.name, p.order])).toEqual([
      ['Ana Ruiz', '1'],
      ['Beto Díaz', '2'],
      ['Caro Gómez', '3'],
    ]);
    expect(perfiles.every((p) => p.label === true && p.otpCode === true)).toBe(true);
    expect(perfiles[0].options).toEqual({ whatsapp: true, otpCode: 'phone' });
    expect(perfiles[0].phone).toBe('+573001112233');
    expect(perfiles.some((p) => /cofianza/i.test(p.name))).toBe(false);
  });

  it('identification e identificationType van juntos; un tipo que Auco no acepta no se manda', () => {
    const [arr] = construirSignProfile([ARRENDATARIO]);
    expect(arr).toMatchObject({ identification: '100200300', identificationType: 'CC', country: 'CO' });
    const [sinTipo] = construirSignProfile([{ ...ARRENDATARIO, tipo_documento: 'ti' }]);
    expect(sinTipo.identification).toBeUndefined();
    expect(sinTipo.identificationType).toBeUndefined();
  });
});

describe('mapEstadoFirmante y decidir', () => {
  const f = (estado: FirmanteSobre['estado']): FirmanteSobre => ({ parteId: 'p1', estado });

  it.each([
    ['FINISH', 'firmado'],
    ['REJECT', 'rechazado'],
    ['BLOCK', 'bloqueado'],
    ['NOTIFICATION', 'notificado'],
    ['PENDING', 'pendiente'],
    [undefined, 'pendiente'],
  ] as const)('%s → %s', (auco, esperado) => {
    expect(mapEstadoFirmante(auco)).toBe(esperado);
  });

  it.each([
    ['FINISH', [], 'activar'],
    ['EXPIRED', [], 'incompleta'],
    ['REJECTED', [], 'incompleta'],
    ['CREATED', [f('rechazado')], 'incompleta'],
    ['CREATED', [f('bloqueado')], 'nada'],
    ['CREATED', [f('notificado')], 'nada'],
    ['LO_QUE_SEA', [f('firmado')], 'nada'],
  ] as const)('documento %s → %s', (status, firmantes, esperado) => {
    expect(decidir({ status }, [...firmantes])).toBe(esperado);
  });
});

describe('ultimaFirma', () => {
  const log = (xs: [string, string][]) => ({
    activityLog: xs.map(([participant, timestamp]) => ({ action: 'PARTICIPANT_SIGN', participant, timestamp })),
  });

  it('con n participantes distintos devuelve el máximo en UTC, venga como venga el orden', () => {
    const r = log([
      ['02', '2026-09-20T15:04:05.940Z'],
      ['01', '2026-09-20T14:00:00.9Z'],
      ['03', '2026-09-20T16:30:00Z'],
    ]);
    expect(ultimaFirma(r, 3)).toBe('2026-09-20T16:30:00.000Z');
  });

  it('faltando un participante devuelve null (no se activa sin la fecha de Auco)', () => {
    expect(ultimaFirma(log([['01', '2026-09-20T14:00:00Z'], ['02', '2026-09-20T15:00:00Z']]), 3)).toBeNull();
    expect(ultimaFirma({ activityLog: [] }, 1)).toBeNull();
    expect(ultimaFirma(null, 1)).toBeNull();
  });

  it('un participante que firma dos veces cuenta una; las demás acciones se ignoran', () => {
    const r = {
      activityLog: [
        { action: 'PARTICIPANT_READ', participant: '01', timestamp: '2026-09-21T10:00:00Z' },
        { action: 'PARTICIPANT_SIGN', participant: '01', timestamp: '2026-09-20T10:00:00Z' },
        { action: 'PARTICIPANT_SIGN', participant: '01', timestamp: '2026-09-20T11:00:00Z' },
        { action: 'PARTICIPANT_SIGN', participant: '02', timestamp: 'no-es-fecha' },
      ],
    };
    expect(ultimaFirma(r, 2)).toBeNull();
    expect(ultimaFirma(r, 1)).toBe('2026-09-20T11:00:00.000Z');
  });
});

describe('actualizarFirmantes y fechasDeFirma', () => {
  const firmantes: FirmanteSobre[] = [
    { parteId: 'p1', estado: 'pendiente' },
    { parteId: 'p2', estado: 'pendiente' },
    { parteId: 'p3', estado: 'pendiente' },
  ];

  it('empareja por correo sin distinguir mayúsculas y guarda el id de Auco', () => {
    const r = actualizarFirmantes(firmantes, TRES, [
      { id: 'G8', email: 'ARRENDATARIO@EJEMPLO.CO', status: 'FINISH' },
      { id: 'H9', email: 'coarrendatario@ejemplo.co', status: 'NOTIFICATION' },
    ]);
    expect(r[0]).toMatchObject({ estado: 'firmado', aucoId: 'G8' });
    expect(r[1]).toMatchObject({ estado: 'notificado', aucoId: 'H9' });
    expect(r[2]).toMatchObject({ estado: 'pendiente' });
  });

  it('una firma ya registrada no se degrada y un firmante ajeno no entra', () => {
    const previos: FirmanteSobre[] = [{ parteId: 'p1', estado: 'firmado', firmadoEn: '2026-09-20T10:00:00.000Z' }];
    const r = actualizarFirmantes(previos, TRES, [{ id: 'G8', email: 'otro@ejemplo.co', status: 'PENDING' }]);
    expect(r[0].estado).toBe('firmado');
    expect(actualizarFirmantes(previos, TRES, undefined)).toEqual(previos);
  });

  it('la fecha sale del roadmap por teléfono y, si el participante no lo trae, por correo', () => {
    const firmados: FirmanteSobre[] = [
      { parteId: 'p1', estado: 'firmado' },
      { parteId: 'p2', estado: 'firmado' },
      { parteId: 'p3', estado: 'pendiente' },
    ];
    const roadmap = {
      participants: [
        { id: '01', phone: '+57 300 111 2233' },
        { id: '02', email: 'COARRENDATARIO@ejemplo.co' },
      ],
      activityLog: [
        { action: 'PARTICIPANT_SIGN', participant: '01', timestamp: '2026-09-20T10:00:00Z' },
        { action: 'PARTICIPANT_SIGN', participant: '02', timestamp: '2026-09-20T12:00:00Z' },
      ],
    };
    const r = fechasDeFirma(firmados, TRES, roadmap);
    expect(r[0].firmadoEn).toBe('2026-09-20T10:00:00Z');
    expect(r[1].firmadoEn).toBe('2026-09-20T12:00:00Z');
    expect(r[2].firmadoEn).toBeUndefined();
    expect(fechasDeFirma(firmados, TRES, null)).toEqual(firmados);
  });
});

describe('sobreIdDeCustom', () => {
  const id = '3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607';

  it('lee el objeto del upload, el arreglo del webhook y el texto plano', () => {
    expect(sobreIdDeCustom({ cofianza_sobre: id })).toBe(id);
    expect(sobreIdDeCustom([`cofianza_sobre: '${id}'`])).toBe(id);
    expect(sobreIdDeCustom(`{'cofianza_sobre': '${id}'}`)).toBe(id);
  });

  it('sin custom usable devuelve null', () => {
    expect(sobreIdDeCustom(undefined)).toBeNull();
    expect(sobreIdDeCustom({ otra: 'cosa' })).toBeNull();
    expect(sobreIdDeCustom({ cofianza_sobre: 'no-es-uuid' })).toBeNull();
  });
});

describe('textoAvisoFirmaIncompleta', () => {
  it('dice que la fianza no está operando y por qué, y cómo se reenvía', () => {
    const t = textoAvisoFirmaIncompleta({
      numero: 'CTO-2026-0007',
      direccion: 'Calle 1 # 2-3',
      motivo: 'EXPIRED',
      crcVigenteHasta: '30/09/2026',
    });
    expect(t).toContain('CTO-2026-0007');
    expect(t).toContain('venció el plazo');
    expect(t).toContain('NO está operando');
    expect(t).toContain('30/09/2026');
    const rechazo = textoAvisoFirmaIncompleta({
      numero: 'CTO-2026-0008',
      direccion: 'Calle 4',
      motivo: 'REJECTED',
      detalle: 'el arrendatario no está de acuerdo',
    });
    expect(rechazo).toContain('rechazó la firma');
    expect(rechazo).toContain('el arrendatario no está de acuerdo');
  });
});
