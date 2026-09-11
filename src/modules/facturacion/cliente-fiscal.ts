/**
 * El CLIENTE de la factura electrónica — funciones puras.
 *
 * Normalmente es el solicitante. Con la opción B (Adenda 2 §7) paga la
 * inmobiliaria o el propietario por la pasarela, y la factura va a nombre de
 * quien pagó: sus datos salen del perfil (el de la ORGANIZACIÓN, con su NIT).
 * Un solo formato para los dos casos, para que la vista previa, la validación
 * y el payload de Factus no se separen.
 */

export interface ClienteFiscal {
  tipo_persona: 'natural' | 'juridica';
  nombre_completo: string;
  razon_social: string;
  /** 'cc' | 'ce' | 'ti' | 'nit' (tributarios colombianos). */
  tipo_documento: string;
  /** Sin dígito de verificación. */
  numero_documento: string;
  digito_verificacion: string;
  email: string;
  telefono: string;
  direccion: string;
  /** Código DANE, 5 dígitos. */
  municipio_codigo: string;
  municipio_nombre: string;
  tribute_code: string;
}

export interface SolicitanteFiscal {
  tipo_persona: 'natural' | 'juridica' | null;
  nombre: string;
  apellido: string;
  razon_social: string | null;
  email: string;
  telefono: string | null;
  tipo_documento: string;
  numero_documento: string;
  digito_verificacion: string | null;
  direccion: string | null;
  municipio_id: string | null;
  municipio_nombre: string | null;
  tribute_code: string | null;
}

export function clienteDesdeSolicitante(sol: SolicitanteFiscal): ClienteFiscal {
  return {
    tipo_persona: sol.tipo_persona ?? 'natural',
    nombre_completo: `${sol.nombre} ${sol.apellido}`.trim(),
    razon_social: sol.razon_social?.trim() ?? '',
    tipo_documento: sol.tipo_documento || '',
    numero_documento: sol.numero_documento || '',
    digito_verificacion: sol.digito_verificacion?.trim() ?? '',
    email: sol.email || '',
    telefono: sol.telefono || '',
    direccion: sol.direccion || '',
    municipio_codigo: sol.municipio_id || '',
    municipio_nombre: sol.municipio_nombre || '',
    tribute_code: sol.tribute_code?.trim() || 'ZZ',
  };
}

export interface PerfilFiscal {
  nombre: string | null;
  apellido: string | null;
  tipo_documento: string | null;
  numero_documento: string | null;
  razon_social: string | null;
  nit: string | null;
  domicilio_direccion: string | null;
  direccion_comercial: string | null;
  direccion: string | null;
  telefono: string | null;
  whatsapp_recaudo: string | null;
  email_recaudo: string | null;
  municipio_codigo: string | null;
  municipio_nombre: string | null;
}

/**
 * Opción B: el arrendador que pagó. Con NIT es persona jurídica —el perfil lo
 * guarda con el DV, "900123456-7"—; sin NIT, persona natural con su documento.
 */
export function clienteDesdePerfil(p: PerfilFiscal, emailPagador: string | null): ClienteFiscal {
  const nit = (p.nit ?? '').replace(/[.\s]/g, '');
  const conDv = nit.match(/^(\d+)-(\d)$/);
  const juridica = nit.length > 0;
  return {
    tipo_persona: juridica ? 'juridica' : 'natural',
    nombre_completo: `${p.nombre ?? ''} ${p.apellido ?? ''}`.trim(),
    razon_social: p.razon_social?.trim() ?? '',
    tipo_documento: juridica ? 'nit' : (p.tipo_documento ?? ''),
    numero_documento: juridica ? (conDv ? conDv[1] : nit) : (p.numero_documento ?? ''),
    digito_verificacion: conDv ? conDv[2] : '',
    email: p.email_recaudo || emailPagador || '',
    telefono: p.telefono || p.whatsapp_recaudo || '',
    direccion: p.domicilio_direccion || p.direccion_comercial || p.direccion || '',
    municipio_codigo: p.municipio_codigo ?? '',
    municipio_nombre: p.municipio_nombre ?? '',
    tribute_code: 'ZZ',
  };
}

export interface DatosFiscalesPagoOverride {
  numero_documento?: string;
  tipo_documento?: string;
  nombre_completo?: string;
  direccion?: string;
  email?: string;
  telefono?: string;
  /** Codigo DANE (5 digitos). */
  municipio_codigo?: string;
}

/** Lo que el usuario corrige en el modal de facturar gana sobre lo guardado. */
export function aplicarOverride(c: ClienteFiscal, o?: DatosFiscalesPagoOverride): ClienteFiscal {
  if (!o) return c;
  const v = (x?: string) => x?.trim() || undefined;
  return {
    ...c,
    numero_documento: v(o.numero_documento) ?? c.numero_documento,
    tipo_documento: v(o.tipo_documento) ?? c.tipo_documento,
    nombre_completo: v(o.nombre_completo) ?? c.nombre_completo,
    direccion: v(o.direccion) ?? c.direccion,
    email: v(o.email) ?? c.email,
    telefono: v(o.telefono) ?? c.telefono,
    municipio_codigo: v(o.municipio_codigo) ?? c.municipio_codigo,
  };
}

/**
 * Lo que Factus/DIAN exigen, igual para la vista previa y la emisión. El tipo
 * de documento debe ser tributario colombiano: el pasaporte del registro no
 * sirve para facturar.
 */
export function faltantesFiscales(c: ClienteFiscal): string[] {
  const faltantes: string[] = [];
  if (!['cc', 'ce', 'ti', 'nit'].includes(c.tipo_documento.toLowerCase())) faltantes.push('tipo_documento');
  if (!c.numero_documento) faltantes.push('numero_documento');
  if (!c.email) faltantes.push('email');
  if (!c.direccion) faltantes.push('direccion');
  if (!c.telefono) faltantes.push('telefono');
  if (!/^\d{5}$/.test(c.municipio_codigo)) faltantes.push('municipio_codigo');
  if (c.tipo_persona === 'juridica') {
    if (!c.razon_social) faltantes.push('razon_social');
    if (!/^\d$/.test(c.digito_verificacion)) faltantes.push('digito_verificacion');
  }
  return faltantes;
}
