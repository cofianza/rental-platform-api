import { z } from 'zod';

export const orgParams = z.object({ inmobiliariaId: z.uuid({ error: 'Inmobiliaria inválida' }) });

export const habilitacionParams = orgParams.extend({
  destinacion: z.enum(['vivienda', 'comercial'], { error: 'La destinación debe ser vivienda o comercial' }),
});

export const documentoHabilitacionParams = habilitacionParams.extend({
  tipo: z.enum(['plantilla', 'convenio'], { error: 'El documento debe ser plantilla o convenio' }),
});

const textoOpcional = z.string().trim().max(2000).nullish();

// Checklist §1.1.4 de la revisión de la plantilla de contrato.
export const guardarHabilitacionSchema = z.object({
  estado: z.enum(['habilitada', 'con_observaciones', 'no_habilitada'], {
    error: 'El estado debe ser habilitada, con_observaciones o no_habilitada',
  }),
  arrendador_es_inmobiliaria: z.boolean().nullish(),
  habeas_subrogatario: z.boolean().nullish(),
  orden_imputacion: textoOpcional,
  regimen_prorroga: textoOpcional,
  deposito_dinero: z.boolean().nullish(),
  renovacion_comercial: textoOpcional,
  observaciones: textoOpcional,
  convenio_vigente_confirmado: z.boolean().default(false),
});
export type GuardarHabilitacionInput = z.infer<typeof guardarHabilitacionSchema>;

export const suspenderSchema = z.object({
  motivo: z.string().trim().min(5, 'Indique el motivo de la suspensión').max(500),
});

export const loteParams = z.object({ loteId: z.uuid({ error: 'Lote inválido' }) });

export const validarQuery = z.object({ formato: z.enum(['json', 'xlsx']).default('json') });

// Llega como multipart (campos de texto junto al archivo). El acta la firma este representante legal por Auco (§3.3).
export const procesarSchema = z.object({
  rep_legal_nombre: z.string().trim().min(3, 'Indique el nombre del representante legal').max(200),
  rep_legal_documento: z.string().trim().min(3, 'Indique el documento del representante legal').max(30),
  rep_legal_email: z.email({ error: 'Correo del representante legal no válido' }).max(255),
  rep_legal_celular: z.string().trim().min(7, 'Indique el celular del representante legal').max(20),
});
export type ProcesarInput = z.infer<typeof procesarSchema>;

// ── Cartera migrada (§5-§8) ──

export const filaParams = z.object({ filaId: z.uuid({ error: 'Contrato migrado inválido' }) });
export const auditoriaParams = z.object({ auditoriaId: z.uuid({ error: 'Auditoría inválida' }) });

const notas = z.string().trim().max(2000).nullish();

export const revisionSchema = z.object({
  en_revision: z.boolean({ error: 'Indique si el contrato queda en revisión' }),
  motivo: z.string().trim().max(500).nullish(),
});

// Exclusión directa: solo por declaración falsa verificada (§7.2.1). La de
// auditoría no entregada sale de la decisión de la auditoría (§7.3.3).
export const exclusionSchema = z.object({ nota: notas });

export const auditoriaSchema = z.object({ notas });

// Llega como multipart (soporte PDF opcional en «archivo»).
export const respuestaAuditoriaSchema = z.object({ notas });

export const decisionAuditoriaSchema = z.object({
  resultado: z.enum(['conforme', 'declaracion_falsa', 'no_entregado'], {
    error: 'El resultado debe ser conforme, declaracion_falsa o no_entregado',
  }),
  notas,
});

export const reportableSchema = z.object({
  motivo: z.enum(['autorizacion_arrendatario', 'verificacion_individual'], {
    error: 'El motivo debe ser autorizacion_arrendatario o verificacion_individual',
  }),
  fecha: z.iso.date({ error: 'Fecha inválida (AAAA-MM-DD)' }).nullish(),
  notas,
});

const formato = z.enum(['json', 'xlsx']).default('json');

export const listarLotesQuery = z.object({ inmobiliariaId: z.uuid({ error: 'Inmobiliaria inválida' }).optional() });

export const tableroQuery = z.object({ formato, vista: z.enum(['cofianza', 'inmobiliaria']).default('cofianza') });

export const reporteQuery = listarLotesQuery.extend({ formato });

export const liquidacionQuery = reporteQuery.extend({
  mes: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Indique el mes como AAAA-MM'),
});
