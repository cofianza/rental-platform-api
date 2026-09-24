import { describe, it, expect, vi } from 'vitest';

// Dependencias con efectos al importar (reglas.ts llega a firma-multiparte por
// mapTipoDocumentoToAuco/aucoDeriveCountry). `@/lib/auco` NO se mockea: sus
// funciones puras (normalizePhoneToInternational) son parte de lo que se prueba.
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), storage: {} }, supabaseAuth: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: { AUCO_SENDER_EMAIL: 'firma@cofianza.co' } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));

import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import {
  actualizarFirmantes,
  construirSignProfile,
  datosDeFirma,
  decidir,
  exigirPlazoDeFirma,
  faltanMarcas,
  fechaHora,
  fechasDeFirma,
  finDelCrc,
  finDelDia,
  firmantesDePartes,
  fueraDePlazo,
  mapEstadoFirmante,
  marcasAjenas,
  paginaPdf,
  partesCompletas,
  plazoDeFirma,
  posicionAuco,
  posicionesDeFirma,
  prorrogaDelPlazo,
  sobreIdDeCustom,
  textoAvisoFirmaIncompleta,
  ultimaFirma,
  validarFirmantes,
  type FirmanteSobre,
  type ParteFirmante,
} from '../reglas';
import type { MarcaFirma } from '../../asistente.types';

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
    // Sin fecha de vigencia el estudio ya venció: no se promete un reenvío que da CRC_VENCIDO.
    expect(rechazo).not.toContain('Puedes reenviarlo');
    expect(rechazo).toContain('se requiere una nueva evaluación');
  });

  it('v3 (Adenda 1): pide aceptarlo en la plataforma y explica la firma fuera de plazo', () => {
    const t = textoAvisoFirmaIncompleta({
      numero: 'CTO-2026-0009',
      direccion: 'Calle 5',
      motivo: 'FUERA_PLAZO',
      detalle: 'la última firma fue el 09/10/2026 a las 00:20',
      crcVigenteHasta: '30/10/2026 a las 10:00',
    });
    expect(t).toContain('después del plazo para firmar (la última firma fue el 09/10/2026 a las 00:20) y no cuentan');
    expect(t).toContain('más de tres días de vigencia (vence el 30/10/2026 a las 10:00)');
    expect(t).toContain('primero acepta este aviso en la plataforma');
  });
});

describe('plazo de firma (Adenda 1 del módulo de contratos, respuesta 10)', () => {
  // Enviado el 23/09/2026 a las 3:07 p. m. en Bogotá.
  const AHORA = Date.parse('2026-09-23T15:07:00-05:00');
  const HORA = 3_600_000;

  it('el plazo corre hasta la medianoche del último día, en Bogotá', () => {
    expect(finDelDia('2026-10-08')).toBe(Date.parse('2026-10-09T04:59:59Z'));
  });

  it('15 días; a Auco va el máximo con la prórroga (30), porque allá no se puede mover', () => {
    expect(plazoDeFirma(AHORA, 15, finDelDia('2026-11-20'))).toEqual({
      expiraEn: finDelDia('2026-10-08'),
      aucoExpira: finDelDia('2026-10-23'),
    });
  });

  it('nunca pasa la vigencia del CRC, ni en Cofianza ni en Auco (hora exacta de vencimiento)', () => {
    const finCrc = Date.parse('2026-10-01T15:30:00-05:00');
    expect(plazoDeFirma(AHORA, 15, finCrc)).toEqual({ expiraEn: finCrc, aucoExpira: finCrc });
  });

  it('con menos de 3 días + 1 h de CRC no se abre el proceso (Auco no acepta menos): hay que renovar la evaluación', () => {
    const justo = AHORA + 3 * 24 * HORA + HORA;
    expect(plazoDeFirma(AHORA, 15, justo - 1)).toEqual({ motivo: 'sin_margen' });
    expect(plazoDeFirma(AHORA, 15, justo)).toEqual({ expiraEn: justo, aucoExpira: justo });
    expect(() => exigirPlazoDeFirma(justo - 1, 15, AHORA)).toThrow(/menos de tres días.*renovar la evaluación/);
    expect(() => exigirPlazoDeFirma(justo - 1, 15, AHORA)).toThrow(expect.objectContaining({ statusCode: 409, errorCode: 'CRC_SIN_MARGEN' }));
  });

  it('con el CRC vencido, o sin fechas, no hay proceso de firma', () => {
    expect(plazoDeFirma(AHORA, 15, AHORA)).toEqual({ motivo: 'vencido' });
    expect(() => exigirPlazoDeFirma(null, 15, AHORA)).toThrow(expect.objectContaining({ errorCode: 'CRC_VENCIDO' }));
  });

  it('el fin del CRC es su fecha_vencimiento exacta (la de /verificar); sin ella, completado + vigencia', () => {
    expect(finDelCrc('2026-10-31T16:00:00Z', '2026-09-01T15:00:00Z', 60)).toBe(Date.parse('2026-10-31T16:00:00Z'));
    expect(finDelCrc(null, '2026-09-01T15:00:00Z', 60)).toBe(Date.parse('2026-10-31T15:00:00Z'));
    expect(finDelCrc(undefined, null, 60)).toBeNull();
  });

  it('una firma después del plazo (más 10 min de reloj) o del fin del CRC no activa la fianza', () => {
    const plazo = '2026-10-09T04:59:59.000Z'; // medianoche del 08/10 en Bogotá
    const mas = (min: number) => new Date(Date.parse(plazo) + min * 60_000).toISOString();
    expect(fueraDePlazo(mas(-60), plazo, null)).toBe(false);
    expect(fueraDePlazo(mas(9), plazo, null)).toBe(false); // tolerancia de reloj
    expect(fueraDePlazo(mas(11), plazo, null)).toBe(true);
    // En ningún caso después del fin del CRC, ni dentro de la tolerancia.
    expect(fueraDePlazo(mas(5), plazo, Date.parse(plazo))).toBe(true);
  });

  it('las horas se dicen en Bogotá', () => {
    expect(fechaHora(Date.parse('2026-10-09T04:59:59Z'))).toBe('08/10/2026 a las 23:59');
  });

  it('la prórroga suma otros 15 días al plazo vigente, sin pasar el CRC', () => {
    const plazo = finDelDia('2026-10-08');
    expect(prorrogaDelPlazo(plazo, 15, finDelDia('2026-11-20'), AHORA)).toEqual({ hasta: finDelDia('2026-10-23') });
    expect(prorrogaDelPlazo(plazo, 15, finDelDia('2026-10-15'), AHORA)).toEqual({ hasta: finDelDia('2026-10-15') });
  });

  it('sin margen de CRC, o con el plazo ya vencido, no hay prórroga', () => {
    const plazo = finDelDia('2026-10-08');
    expect(prorrogaDelPlazo(plazo, 15, plazo, AHORA)).toEqual({ motivo: 'crc' });
    expect(prorrogaDelPlazo(plazo, 15, finDelDia('2026-11-20'), plazo + 1)).toEqual({ motivo: 'vencido' });
  });
});

// ── Ruta B: firmas sobre el PDF de la inmobiliaria (Adenda 1 contratos, respuesta 6) ──

/** El error que lanza f (para afirmar código y detalle). */
function lanzado(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error('se esperaba un error');
}

describe('posicionAuco (supuesto de Auco a verificar con scripts/sonda-auco-ruta-b.ts)', () => {
  // 75 / 500 = 0,15 y 75 / 750 = 0,1: medio recuadro (150 pt) en relativo, según qué lado se ve de ancho.
  const PAGINA = { ancho: 500, alto: 750 };

  it('el recuadro de 150×50 pt va centrado en la marca con el borde inferior encima: (x, y) = su esquina inferior derecha', () => {
    expect(posicionAuco({ pagina: 3, x: 0.5, y: 0.8 }, { ...PAGINA, rotacion: 0 })).toEqual({ page: 3, x: 0.65, y: 0.8, w: 150, h: 50 });
  });

  it('con /Rotate 90 o 270 el ancho que se ve es el alto de la caja; con 180, el mismo', () => {
    const marca = { pagina: 1, x: 0.5, y: 0.5 };
    expect(posicionAuco(marca, { ...PAGINA, rotacion: 90 })).toMatchObject({ x: 0.6, y: 0.5 });
    expect(posicionAuco(marca, { ...PAGINA, rotacion: 270 })).toMatchObject({ x: 0.6, y: 0.5 });
    expect(posicionAuco(marca, { ...PAGINA, rotacion: 180 })).toMatchObject({ x: 0.65, y: 0.5 });
  });

  it('una marca pegada al borde derecho no se sale de la página', () => {
    expect(posicionAuco({ pagina: 1, x: 0.95, y: 1 }, { ...PAGINA, rotacion: 0 })).toMatchObject({ x: 1, y: 1 });
  });

  it('paginaPdf lee el CropBox (si no hay, el MediaBox) y el /Rotate como pdf.js: negativo normalizado, no múltiplo de 90 = 0', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]).setCropBox(36, 36, 540, 720);
    doc.addPage([612, 792]).setRotation(degrees(-90));
    doc.addPage([612, 792]).node.set(PDFName.of('Rotate'), PDFNumber.of(45));
    const leido = await PDFDocument.load(await doc.save());
    expect(leido.getPages().map(paginaPdf)).toEqual([
      { ancho: 612, alto: 792, rotacion: 0 },
      { ancho: 540, alto: 720, rotacion: 0 },
      { ancho: 612, alto: 792, rotacion: 270 },
      { ancho: 612, alto: 792, rotacion: 0 },
    ]);
    // Girada, lo que se ve tiene 792 pt de ancho; recortada, 540.
    const marca = { pagina: 3, x: 0.5, y: 0.5 };
    expect(posicionAuco(marca, paginaPdf(leido.getPage(2))).x).toBe(Math.round((0.5 + 75 / 792) * 1e4) / 1e4);
    expect(posicionAuco(marca, paginaPdf(leido.getPage(1))).x).toBe(Math.round((0.5 + 75 / 540) * 1e4) / 1e4);
  });
});

describe('posicionesDeFirma y construirSignProfile con posiciones', () => {
  const PAG = { ancho: 500, alto: 750, rotacion: 0 as const };
  const final = (marcas: MarcaFirma[]) => ({ ruta: 'B' as const, firmasPropio: { marcas, paginas: { 1: PAG, 4: PAG } } });
  const MARCAS: MarcaFirma[] = [
    { parte: 'arrendador', pagina: 4, x: 0.7, y: 0.9 },
    { parte: 'arrendatario', pagina: 4, x: 0.2, y: 0.9 },
    { parte: 'arrendatario', pagina: 1, x: 0.85, y: 0.95 }, // iniciales
    { parte: 'coarrendatario', indice: 0, pagina: 4, x: 0.45, y: 0.9 },
  ];
  const pos = (page: number, x: number, y: number) => ({ page, x, y, w: 150, h: 50 });

  it('cada firmante (en orden de firma) lleva todas sus marcas como position, y conserva label', () => {
    const posiciones = posicionesDeFirma([ARRENDADOR, ARRENDATARIO, COARRENDATARIO], final(MARCAS))!;
    expect(posiciones).toEqual([
      [pos(4, 0.35, 0.9), pos(1, 1, 0.95)],
      [pos(4, 0.6, 0.9)],
      [pos(4, 0.85, 0.9)],
    ]);
    const perfiles = construirSignProfile([ARRENDADOR, ARRENDATARIO, COARRENDATARIO], posiciones);
    expect(perfiles.map((p) => [p.name, p.order, p.label, p.position])).toEqual([
      ['Ana Ruiz', '1', true, posiciones[0]],
      ['Beto Díaz', '2', true, posiciones[1]],
      ['Caro Gómez', '3', true, posiciones[2]],
    ]);
  });

  it('Ruta A: sin posiciones, solo las anclas', () => {
    expect(posicionesDeFirma(TRES, { ruta: 'A' })).toBeUndefined();
    expect(construirSignProfile(TRES).some((p) => 'position' in p)).toBe(false);
  });

  it('a una parte sin marca (o sin marcas congeladas): 409 RUTA_B_FIRMAS_INCOMPLETAS con quién falta', () => {
    const sinCoa = MARCAS.filter((m) => m.parte !== 'coarrendatario');
    expect(lanzado(() => posicionesDeFirma(TRES, final(sinCoa)))).toMatchObject({
      statusCode: 409,
      errorCode: 'RUTA_B_FIRMAS_INCOMPLETAS',
      message: expect.stringContaining('Coarrendatario (Beto Díaz)'),
      details: { partes: ['Coarrendatario (Beto Díaz)'] },
    });
    expect(lanzado(() => posicionesDeFirma(TRES, { ruta: 'B' }))).toMatchObject({
      details: { partes: ['Arrendatario (Ana Ruiz)', 'Coarrendatario (Beto Díaz)', 'Arrendador (Caro Gómez)'] },
    });
  });

  it('faltanMarcas y marcasAjenas: el coarrendatario cuenta por su índice; sin él, su marca es ajena', () => {
    expect(faltanMarcas(firmantesDePartes(TRES), MARCAS)).toEqual([]);
    const otroCoa: MarcaFirma = { parte: 'coarrendatario', indice: 1, pagina: 1, x: 0.5, y: 0.5 };
    expect(faltanMarcas(firmantesDePartes(TRES), [...MARCAS.filter((m) => m.parte !== 'coarrendatario'), otroCoa])).toEqual([
      'Coarrendatario (Beto Díaz)',
    ]);
    expect(marcasAjenas(['arrendatario', 'coarrendatario', 'arrendador'], [...MARCAS, otroCoa])).toEqual([otroCoa]);
    expect(marcasAjenas(['arrendatario', 'arrendador'], MARCAS)).toEqual([MARCAS[3]]);
  });
});
