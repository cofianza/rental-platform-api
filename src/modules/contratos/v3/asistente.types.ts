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
export interface Paso5 { ciudadFirma: string; contactos: { arrendador: Contacto; arrendatario: Contacto; coarrendatario: Contacto | null } }
export interface Pasos { 1: Paso1; 2: Paso2; 3: Paso3; 4: Paso4; 5: Paso5 }
export type GuardarPasoBody =
  | { paso: 1; datos: Paso1 } | { paso: 2; datos: Paso2 } | { paso: 3; datos: Paso3 }
  | { paso: 4; datos: Paso4Entrada } | { paso: 5; datos: Paso5 };  // paso 4: la entrada; se guarda Paso4

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
    adicionales: {
      maximo: number; ordinales: string[] /* 25, desde la 1.ª adicional de ESTE contrato */;
      aviso: { version: string; texto: string }; prevalencia: string;
      excesoAutorizado: { huella: string; cantidad: number; en: string } | null;
    };
  };
}

// ── Cláusulas adicionales (Entrega 4) ──
export type OrigenClausula = 'biblioteca' | 'propia';
export type CodigoHallazgo =
  | 'deposito' | 'mascotas' | 'incremento' | 'fianza' | 'renuncia' | 'terminacion' | 'tenencia'
  | 'modifica_contrato' | 'no_imprimible' | 'coarrendatario' | 'instrucciones' | 'revision_automatica'
  | 'cita_numero';
export interface Hallazgo {
  codigo: CodigoHallazgo; etiqueta: string; mensaje: string;
  norma: string | null;          // §5.3.8; null solo en códigos no jurídicos
  fragmento: string | null;      // copia literal del texto que disparó la regla (≤ 200)
  fuente: 'reglas' | 'ia';
  indice?: number;               // posición en la lista del paso 4 (0-based)
}
export interface ClausulaCatalogo {
  id: string; origen: OrigenClausula; titulo: string; texto: string; version: number;
  estado: 'activa' | 'inhabilitada'; inhabilitadaMotivo: string | null;
  campos: string[];              // nombres de [[campo]] en orden de aparición (solo biblioteca)
  actualizadaEn: string;
}
export interface CatalogoClausulas { biblioteca: ClausulaCatalogo[]; propias: ClausulaCatalogo[] }
export interface ClausulaRegistro extends Omit<ClausulaCatalogo, 'estado'> {
  estado: 'activa' | 'inhabilitada' | 'eliminada';
  inmobiliaria: { id: string; nombre: string } | null; usos: number; creadaEn: string;
}
export interface UsoClausula {
  contratoId: string; contratoNumero: string; contratoEstado: string; expedienteId: string;
  version: number; numero: string /* ordinal impreso, p. ej. "TRIGÉSIMA CUARTA" */; en: string;
}
export interface ClausulaEnContrato {
  clausulaId: string; origen: OrigenClausula; version: number;
  titulo: string; texto: string;  // tal como se imprime (campos ya llenos)
  valores: Record<string, string> | null;
  ia: { sha256: string; modelo: string; en: string } | null;
}
export interface AceptacionClausulas {
  usuarioId: string; nombre: string; email: string; rolMiembro: string | null;
  en: string; ip: string | null; avisoVersion: string;
}
export type Paso4 = { omitir: true } | { clausulas: ClausulaEnContrato[]; huella: string; aceptacion: AceptacionClausulas };
export type Paso4Entrada = { omitir: true } | {
  clausulas: { clausulaId: string; valores?: Record<string, string> }[];
  aceptoResponsabilidad: true; avisoVersion: string;
};
