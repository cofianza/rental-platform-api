/**
 * Asistente de contratos V3 (Entrega 3) — lo que el API le devuelve a la web.
 * Se copia LITERAL (desde NumeroPaso) a rental-platform-web/types/contratoV3.ts:
 * la web no consume los tipos del API. Si cambia aquí, se copia allá tal cual.
 */
export type NumeroPaso = 1 | 2 | 3 | 4 | 5;
export interface Contacto { direccion: string; municipio: string; email: string; telefono: string }
export interface Paso1 { ruta: 'A' | 'B'; modalidad: 'trasladada' | 'tradicional'; canonCop: number }
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
    /**
     * Paso 3: de la cuota de administración solo se precarga el valor (§1.3). Si el
     * estudio tuvo un contrato cancelado, sus pasos mandan (el 4 solo trae la lista).
     */
    prefill: {
      1: Partial<Paso1>;
      2: Partial<Paso2>;
      3: Partial<Omit<Paso3, 'administracion'>> & { administracion?: Partial<NonNullable<Paso3['administracion']>> };
      4?: { clausulas: { clausulaId: string; origen: OrigenClausula; valores?: Record<string, string> }[] };
      5: Partial<Paso5>;
    };
    /** Textos sin aprobar que llevará el documento, previstos con lo guardado (bloquean el envío). */
    textosPendientes: string[];
    /** §7.2: la modalidad que fija el convenio de la inmobiliaria (null = no fija). */
    modalidadConvenio: Paso1['modalidad'] | null;
    /** Adenda 1 contratos, respuesta 15: último día hábil de la reserva del inmueble (AAAA-MM-DD). Sin envío a firma, al día siguiente el borrador se cancela solo. */
    reservadoHasta: string;
    faltantes: { paso: NumeroPaso; mensaje: string }[];
    documento: null | { generacion: number; generadoEn: string; avisos: string[]; pendientes: string[]; desactualizado: boolean };
    /** Ruta B: el contrato propio de la inmobiliaria, tal como se cargó (sin modificar, §4.4). */
    propio: PdfPropio | null;
    adicionales: {
      maximo: number; ordinales: string[] /* 25, desde la 1.ª adicional de ESTE contrato */;
      /** texto = responsabilidad (solo propias); modelos = los modelos sin cambios son texto de Cofianza (Adenda 1 contratos, resp. 13). */
      aviso: { version: string; texto: string; modelos: string }; prevalencia: string;
      excesoAutorizado: { huella: string; cantidad: number; en: string } | null;
    };
  };
  /** El contrato ya salió de borrador (Entrega 5): EN FIRMA, FIRMA INCOMPLETA o FIANZA ACTIVA. */
  enviado: EnvioV3 | null;
}

export interface PdfPropio { nombre: string; paginas: number; bytes: number; sha256: string; subidoEn: string }

// ── Firma (Entrega 5) ──
export type EstadoSobreV3 = 'creando' | 'en_firma' | 'completo' | 'incompleto' | 'cancelado' | 'fallido';
export type EstadoFirmanteV3 = 'pendiente' | 'notificado' | 'firmado' | 'rechazado' | 'bloqueado';

/** Un contrato V3 que ya salió de borrador: EN FIRMA, FIRMA INCOMPLETA o FIANZA ACTIVA. */
export interface EnvioV3 {
  id: string;
  numero: string;
  ruta: 'A' | 'B';
  estado: 'pendiente_firma' | 'firma_incompleta' | 'vigente' | 'finalizado';
  /** contratos.fecha_firma: la última firma según Auco (UTC). */
  fechaActivacion: string | null;
  /** TERMINADO (§11.6): cuándo se terminó. */
  fechaTerminacion: string | null;
  /** FIANZA ACTIVA: el período en curso con la prórroga automática (fechas AAAA-MM-DD). */
  vigencia: null | { inicio: string; vencimientoInicial: string; venceEl: string; prorrogas: number };
  /**
   * FIANZA ACTIVA o TERMINADO: el acta de entrega e inventario (§12.1-12.3).
   * `datos` es lo que necesita el módulo de inventario para levantarla.
   */
  acta: null | {
    pendiente: boolean;
    archivos: { id: string; nombre: string; subidoEn: string }[];
    datos: {
      fechaEntrega: string | null;
      amoblado: boolean | null;
      inmueble: { direccion: string | null; municipio: string | null };
      partes: { rol: 'arrendatario' | 'coarrendatario' | 'arrendador'; nombre: string }[];
    };
  };
  sobre: null | {
    intento: number;
    estado: EstadoSobreV3;
    enviadoEn: string;
    expiraEn: string;
    motivo: string | null;
    motivoDetalle: string | null;
    firmantes: {
      rol: 'arrendatario' | 'coarrendatario' | 'arrendador';
      nombre: string;
      /** A donde Auco manda el enlace (WhatsApp) y el correo: para revisar si la firma no llega. */
      telefono: string | null;
      email: string | null;
      orden: number;
      estado: EstadoFirmanteV3;
      firmadoEn: string | null;
    }[];
  };
  /**
   * Aviso de firma incompleta (§11.7.4) ya entregado, con su texto exacto, y su
   * acuse (Adenda 1, respuesta 11): hasta que la inmobiliaria lo acepte, ella no reenvía ni cancela.
   */
  aviso: null | { texto: string; entregadoEn: string; aceptado: null | { nombre: string; en: string } };
  /**
   * EN FIRMA con el proceso vivo: la única prórroga del plazo (Adenda 1, respuesta 10).
   * `hasta` = el plazo nuevo si se prorroga ahora; `usadaEn` = cuándo se prorrogó.
   */
  prorroga: null | { puede: boolean; motivo: string | null; hasta: string | null; usadaEn: string | null };
  /** Verificaciones de identidad que faltan antes de crear el sobre (0 sin biometría). */
  identidadPendientes: number;
  /** FIRMA INCOMPLETA + estudio vigente (§11.7.5). */
  reenvio: { puede: boolean; motivo: string | null };
  /** EN FIRMA sin sobre vivo ni identidad pendiente: el envío falló y se puede reintentar. */
  reintento: boolean;
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
  clausulaId: string;
  origen: OrigenClausula;         // categoría (resp. 13): 'biblioteca' = modelo sin cambios; 'propia' = del arrendador, o un modelo editado
  version: number;
  titulo: string; texto: string;  // tal como se imprime (campos ya llenos)
  valores: Record<string, string> | null;
  ia: { sha256: string; modelo: string; en: string } | null;
}
export interface AceptacionClausulas {
  usuarioId: string; nombre: string; email: string; rolMiembro: string | null;
  en: string; ip: string | null; avisoVersion: string;
  huella: string;                 // de las propias que cubre: los modelos sin cambios quedan fuera (resp. 13)
}
/** aceptacion null = solo modelos sin cambios: no hay nada propio que aceptar. */
export type Paso4 = { omitir: true } | { clausulas: ClausulaEnContrato[]; huella: string; aceptacion: AceptacionClausulas | null };
export type Paso4Entrada = { omitir: true } | {
  clausulas: { clausulaId: string; valores?: Record<string, string> }[];
  aceptoResponsabilidad?: true;   // obligatoria si hay al menos una propia
  avisoVersion: string;
};
