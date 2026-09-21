/**
 * Asistente de contratos V3 (Entrega 3) — lo que el API le devuelve a la web.
 * Se copia LITERAL (desde NumeroPaso) a rental-platform-web/types/contratoV3.ts:
 * la web no consume los tipos del API. Si cambia aquí, se copia allá tal cual.
 */
export type NumeroPaso = 1 | 2 | 3 | 4 | 5;
export interface Contacto { direccion: string; municipio: string; email: string; telefono: string }
export interface Paso1 { ruta: 'A'; modalidad: 'trasladada' | 'tradicional'; canonCop: number }
export interface Paso2 {
  usos: { carro: string | null; moto: string | null; util: string | null }; // null = NO; texto = número/identificación
  amoblado: boolean; ocupantes: number;
  propiedadHorizontal: boolean; nombreCopropiedad: string | null;           // requerido ⇔ PH
}
export interface Administracion { aCargoDe: 'arrendador' | 'arrendatario'; valorCop: number; incluidaEnCanon: boolean }
export interface Paso3 { vigenciaMeses: number; fechaInicio: string; fechaEntrega: string; comisionPct: number; administracion: Administracion | null }
export interface Paso4 { omitir: true }
export interface Paso5 { ciudadFirma: string; contactos: { arrendador: Contacto; arrendatario: Contacto; coarrendatario: Contacto | null } }
export interface Pasos { 1: Paso1; 2: Paso2; 3: Paso3; 4: Paso4; 5: Paso5 }
export type GuardarPasoBody =
  | { paso: 1; datos: Paso1 } | { paso: 2; datos: Paso2 } | { paso: 3; datos: Paso3 }
  | { paso: 4; datos: Paso4 } | { paso: 5; datos: Paso5 };

export interface Bloqueo {
  codigo: string; mensaje: string;
  paso?: NumeroPaso;                                   // se pinta arriba de ese paso
  accion?: 'datos_contrato' | 'estudio' | 'inmueble';
  detalle?: string[];
}
export interface EstadoAsistente {
  habilitado: boolean;
  bloqueos: Bloqueo[];
  avisos: string[];                                    // no bloquean
  resumen: null | {
    expedienteNumero: string;
    arrendador: { razonSocial: string | null; nit: string | null; representanteLegal: string | null;
      matricula: string | null; matriculaExpedidaPor: string | null;
      cuenta: { banco: string | null; tipo: string | null; numero: string | null; titular: string | null; nit: string | null } };
    arrendatario: { nombre: string; tipoDocumento: string; numeroDocumento: string };
    coarrendatario: { nombre: string; tipoDocumento: string; numeroDocumento: string } | null;
    inmueble: { id: string; codigo: string | null; direccion: string; municipio: string; canonRegistroCop: number };
    fianza: null | { via: 'automatica' | 'condicionada_coarrendatario' | 'revision_manual'; primaPct: number;
      tarifaPct: number; ivaPct: number; cashbackPct: number; negociada: boolean;
      crc: { codigo: string; fechaEmision: string; vigenteHasta: string } | null };
    canon: { evaluadoCop: number | null; maximoSinNuevaEvaluacionCop: number | null };
  };
  contrato: null | {
    id: string; numero: string; estado: 'borrador';
    guardados: Partial<Pasos>;
    prefill: { 1: Partial<Paso1>; 2: Partial<Paso2>; 3: Partial<Paso3>; 5: Partial<Paso5> };
    faltantes: { paso: NumeroPaso; mensaje: string }[];
    documento: null | { generadoEn: string; avisos: string[]; desactualizado: boolean };
  };
}
