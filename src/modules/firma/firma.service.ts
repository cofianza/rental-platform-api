import crypto from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import * as aucoClient from '@/lib/auco';
import type { AucoWebhookPayload } from '@/lib/auco';
import { notificarUsuario, findPerfilIdByEmail } from '@/modules/notificaciones/notificaciones.service';
import type { CrearSolicitudFirmaInput } from './firma.schema';

// ============================================================
// DEBUG: PDF de 1 pagina con pdf-lib para aislar si el problema con Auco
// es el PDF Puppeteer del contrato real (fuentes embebidas, tamano,
// estructura) vs la integracion en si. Activa con AUCO_DEBUG_SIMPLE_PDF=true
// en Railway. Quitar esto cuando estabilicemos.
// ============================================================
async function buildDebugPdf(params: {
  firmanteName: string;
  direccionInmueble: string;
  expedienteNumero: string;
}): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText('Cofianza — Contrato de Arrendamiento (DEBUG)', {
    x: 50, y: 780, size: 16, font: bold, color: rgb(0.06, 0.46, 0.43),
  });
  page.drawText('Este es un PDF de prueba simplificado generado con pdf-lib', {
    x: 50, y: 740, size: 11, font,
  });
  page.drawText('para aislar fallos del flow de firma con Auco.', {
    x: 50, y: 725, size: 11, font,
  });
  page.drawText(`Expediente: ${params.expedienteNumero}`, {
    x: 50, y: 680, size: 12, font,
  });
  page.drawText(`Firmante: ${params.firmanteName}`, {
    x: 50, y: 660, size: 12, font,
  });
  page.drawText(`Inmueble: ${params.direccionInmueble}`, {
    x: 50, y: 640, size: 12, font,
  });
  page.drawText(`Fecha: ${new Date().toISOString()}`, {
    x: 50, y: 620, size: 11, font,
  });
  page.drawText('Al firmar, declaras que aceptas los terminos del arrendamiento.', {
    x: 50, y: 580, size: 11, font,
  });
  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

// ============================================================
// Constants
// ============================================================

const TOKEN_EXPIRY_HOURS = 72;
const MAX_ENVIOS_DEFAULT = 5;
const BUCKET_NAME = 'documentos-expedientes';

// ============================================================
// Helper: construye un signProfile para Auco siguiendo las reglas de
// validacion de identidad (https://docs.auco.ai/api/manager/validations).
//
// - Si el firmante tiene telefono internacional (+57XXXXXXXXXX),
//   activamos el flow por WhatsApp con OTP por phone (todo el proceso
//   sucede en WhatsApp, incluyendo el OTP). Auco usa su propia linea
//   de WhatsApp Business — el costo de la conversacion lo asume Auco
//   en su plan, no Cofianza (acuerdo del 2026-04-29 con A. Diaz).
// - Si no hay telefono valido, usamos solo email — el OTP llega al
//   correo y el firmante completa la firma desde nuestra UI publica.
// ============================================================

// Mapea tipo_documento de nuestro DB al formato Auco. Auco usa codigos
// estandar colombianos en mayusculas (CC, CE, TI, NIT, PASAPORTE).
// Tipos de documento que Auco acepta para un FIRMANTE (persona natural). NIT
// (empresa) y TI NO están en la lista → mapean a null y no se envían (Auco
// rechaza el sobre con 400 si identificationType no está en su lista).
const AUCO_DOC_TYPES = new Set([
  'CC', 'CE', 'PPT', 'PEP', 'CI', 'RUT', 'RUN', 'CCCR', 'DUI', 'DNI', 'CURP', 'PASSPORT',
]);

function mapTipoDocumentoToAuco(tipoDocumento: string | null | undefined): string | null {
  if (!tipoDocumento) return null;
  const tipo = tipoDocumento.trim().toLowerCase();
  const alias: Record<string, string> = {
    cc: 'CC', ce: 'CE', pep: 'PEP', ppt: 'PPT', ci: 'CI',
    dni: 'DNI', curp: 'CURP', rut: 'RUT',
    pasaporte: 'PASSPORT', passport: 'PASSPORT',
  };
  const mapped = alias[tipo] ?? tipo.toUpperCase();
  return AUCO_DOC_TYPES.has(mapped) ? mapped : null;
}

// Deriva el codigo ISO de pais a partir del prefijo internacional del telefono.
// Auco usa este `country` para anclar la validacion biometrica al pais correcto;
// si lo dejamos hardcodeado en 'CO' pero el phone es +52 (Mexico), Auco rechaza
// el flow al hacer click "Comenzar" en WhatsApp porque hay incoherencia.
function deriveCountryFromPhone(phoneInternational: string | null): string | null {
  if (!phoneInternational) return null;
  const trimmed = phoneInternational.trim();
  // Mapeo prefijo → ISO. Solo paises de America de habla hispana / mas comunes
  // de testing por ahora; ampliar segun se requiera.
  if (trimmed.startsWith('+57')) return 'CO'; // Colombia
  if (trimmed.startsWith('+52')) return 'MX'; // Mexico
  if (trimmed.startsWith('+593')) return 'EC'; // Ecuador
  if (trimmed.startsWith('+51')) return 'PE'; // Peru
  if (trimmed.startsWith('+58')) return 'VE'; // Venezuela
  if (trimmed.startsWith('+506')) return 'CR'; // Costa Rica
  if (trimmed.startsWith('+507')) return 'PA'; // Panama
  if (trimmed.startsWith('+1')) return 'US'; // US/Canada (no podemos distinguir aqui)
  return null;
}

interface SignProfileInput {
  name: string;
  email: string;
  phoneInternational: string | null;
  /** Numero de documento del firmante. Necesario para validacion biometrica
   *  via cotejo (options.camera = 'identification'). Si no esta, caemos a
   *  options.camera = 'photo' (solo selfie, sin cotejo de ID). */
  identification?: string | null;
  /** Tipo de documento — Auco espera codigos en mayusculas (CC, CE, TI, ...) */
  identificationType?: string | null;
  /** Codigo ISO del pais. Para Cofianza en Colombia → 'CO'. */
  country?: string | null;
}

interface SignProfileOutput {
  name: string;
  email: string;
  phone?: string;
  // Auco exige al menos uno de [type, label, position] por firmante. Usamos
  // `position` (default abajo a la derecha) para alinear con el payload del
  // proyecto Temporal/Nest que SI funciona end-to-end. `role` y `type` no
  // estan en la doc oficial de Auco y agregarlos no aporta — los quitamos.
  position?: Array<{ page: number; x: number; y: number; w: number; h: number }>;
  // Validaciones de identidad — segun la doc de Auco, declarar `options`
  // requiere activar `camera` u `otpCode` boolean en el mismo nivel; ambos
  // los activamos para WhatsApp.
  camera?: boolean;
  otpCode?: boolean;
  /** Notificacion por WhatsApp + email simultaneamente. */
  both?: boolean;
  identification?: string;
  identificationType?: string;
  country?: string;
  options?: {
    whatsapp?: boolean;
    /** Mismo `both` pero dentro de options — la doc lo pide en ambos lados. */
    both?: boolean;
    otpCode?: 'phone' | 'email';
    camera?: 'identification' | 'photo';
  };
}

// Posicion default del cuadro de firma — abajo a la derecha de la primera
// pagina. Mismo valor que usa el proyecto Temporal de prueba que funciona.
const DEFAULT_SIGN_POSITION = [
  { page: 1, x: 0.6, y: 0.85, w: 150, h: 50 },
];

function buildSignProfile(params: SignProfileInput): SignProfileOutput {
  const { name, email, phoneInternational, identification, identificationType, country } = params;

  const tipoAuco = mapTipoDocumentoToAuco(identificationType);
  const idNumero = identification?.trim() || null;

  // El country lo derivamos del prefijo del telefono — si pasamos country='CO'
  // pero phone='+52' (Mexico), Auco rechaza con "Se ha producido un error
  // inesperado". El `country` que venga en params solo se usa como fallback
  // cuando el phone no se puede mapear.
  const countryFromPhone = deriveCountryFromPhone(phoneInternational);
  const countryCode = countryFromPhone || (country?.trim().toUpperCase() || null);

  // Decision Mario 8-may-2026: simplificar el flow de firma — solo OTP por
  // WhatsApp, sin paso de selfie/foto. El cotejo biometrico complicaba las
  // pruebas y agregaba un paso que el firmante percibia como friccion. Si
  // necesitamos endurecer la validacion de identidad mas adelante, volvemos
  // a meter `camera: true` y `options.camera: 'photo' | 'identification'`.

  if (phoneInternational) {
    // Flow EXCLUSIVO por WhatsApp. El firmante recibe el link, el OTP y
    // confirma todo desde WhatsApp — sin selfie.
    const profile: SignProfileOutput = {
      name,
      email,
      phone: phoneInternational,
      // position obligatorio segun la doc de Auco — sin esto, options no se
      // valida y el flow falla silencioso al hacer click "Comenzar" en
      // WhatsApp con "Se ha producido un error inesperado".
      position: DEFAULT_SIGN_POSITION,
      otpCode: true,
      options: {
        whatsapp: true,
        otpCode: 'phone',
      },
    };
    if (idNumero && tipoAuco) {
      profile.identification = idNumero;
      profile.identificationType = tipoAuco;
    }
    if (countryCode) profile.country = countryCode;
    return profile;
  }

  // Sin telefono → flow email-only.
  const profile: SignProfileOutput = {
    name,
    email,
    position: DEFAULT_SIGN_POSITION,
    otpCode: true,
    options: {
      otpCode: 'email',
    },
  };
  if (idNumero && tipoAuco) {
    profile.identification = idNumero;
    profile.identificationType = tipoAuco;
  }
  if (countryCode) profile.country = countryCode;
  return profile;
}

// Estados validos del contrato para crear solicitudes de firma
const ESTADOS_VALIDOS_FIRMA = ['pendiente_firma'];

const SOLICITUD_SELECT = `
  id, contrato_id, nombre_firmante, email_firmante, telefono_firmante,
  token, token_expiracion, estado, envios_realizados, max_envios,
  enviado_por, abierto_en, firmado_en, ip_firmante, user_agent_firmante,
  auco_document_code, auco_signed_url,
  created_at, updated_at
`;

// ============================================================
// Types
// ============================================================

interface SolicitudFirmaRow {
  id: string;
  contrato_id: string;
  nombre_firmante: string;
  email_firmante: string;
  telefono_firmante: string | null;
  token: string;
  token_expiracion: string;
  estado: string;
  envios_realizados: number;
  max_envios: number;
  enviado_por: string;
  abierto_en: string | null;
  firmado_en: string | null;
  ip_firmante: string | null;
  user_agent_firmante: string | null;
  auco_document_code: string | null;
  auco_signed_url: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Crear solicitud y enviar a Auco para firma
// ============================================================

export async function crearSolicitudFirma(
  input: CrearSolicitudFirmaInput,
  userId: string,
  ip?: string,
) {
  // 1. Validate contrato exists and is in valid state
  const { data: contrato, error: contratoError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, expediente_id, storage_key, nombre_archivo')
    .eq('id', input.contrato_id)
    .single();

  if (contratoError || !contrato) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  const c = contrato as unknown as {
    id: string; estado: string; expediente_id: string;
    storage_key: string | null; nombre_archivo: string | null;
  };

  if (!ESTADOS_VALIDOS_FIRMA.includes(c.estado)) {
    throw AppError.badRequest(
      `El contrato debe estar en estado "Pendiente de firma" para enviar una solicitud. Estado actual: ${c.estado}`,
      'INVALID_CONTRACT_STATE',
    );
  }

  if (!c.storage_key) {
    throw AppError.badRequest(
      'El contrato no tiene PDF generado para enviar a firma',
      'NO_PDF',
    );
  }

  // 2. Fetch expediente + inmueble + solicitante data
  // El solicitante es necesario para Auco: identification, identificationType
  // y country son requeridos para activar la validacion biometrica
  // (options.camera = 'identification') segun la doc de Auco.
  const { data: expediente } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('numero, inmuebles(direccion, ciudad), solicitantes(tipo_documento, numero_documento)')
    .eq('id', c.expediente_id)
    .single();

  const exp = expediente as unknown as {
    numero: string;
    inmuebles: { direccion: string; ciudad: string } | null;
    solicitantes: { tipo_documento: string | null; numero_documento: string | null } | null;
  } | null;

  // 3. Generate secure token
  const token = crypto.randomBytes(32).toString('hex');
  const tokenExpiracion = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

  // 4. Download PDF from storage and upload to Auco
  let aucoDocumentCode: string | null = null;
  // Lo levantamos al scope externo para decidir despues si enviamos el
  // email custom de fallback o no.
  let enableWhatsapp = false;
  const direccionInmueble = exp?.inmuebles?.direccion || 'N/A';
  const ciudadInmueble = exp?.inmuebles?.ciudad || '';
  // Datos del solicitante para validacion de identidad en Auco. Cofianza
  // opera en Colombia, asi que asumimos country='CO' por defecto.
  const solicitanteIdentification = exp?.solicitantes?.numero_documento || null;
  const solicitanteIdentificationType = exp?.solicitantes?.tipo_documento || null;
  const solicitanteCountry = 'CO';

  try {
    let buffer: Buffer;

    // DEBUG: si la env AUCO_DEBUG_SIMPLE_PDF=true, en lugar del contrato real
    // (Puppeteer, ~150 KB con fuentes embebidas) subimos un PDF simple de 1
    // pagina con pdf-lib (~5 KB, fuentes estandar). Aisla la variable PDF
    // para diagnosticar fallos de Auco al iniciar el flow de firma.
    if (process.env.AUCO_DEBUG_SIMPLE_PDF === 'true') {
      buffer = await buildDebugPdf({
        firmanteName: input.nombre_firmante,
        direccionInmueble,
        expedienteNumero: exp?.numero || c.id,
      });
      logger.warn(
        { contratoId: c.id, sizeBytes: buffer.length },
        'AUCO_DEBUG_SIMPLE_PDF=true — usando PDF simple en lugar del contrato real',
      );
    } else {
      const { data: pdfData, error: downloadError } = await supabase.storage
        .from(BUCKET_NAME)
        .download(c.storage_key);

      if (downloadError || !pdfData) {
        throw new Error(downloadError?.message || 'No se pudo descargar el PDF');
      }

      buffer = Buffer.from(await pdfData.arrayBuffer());
    }
    const pdfBase64 = aucoClient.bufferToBase64(buffer);

    const processName = `Contrato - ${exp?.numero || c.id}`;

    // Normalizar el teléfono a formato internacional (+57...) para que Auco
    // pueda enviar el link de firma por WhatsApp. Sin telefono valido NO hay
    // firma — Mario decidió que el proceso es 100% WhatsApp (7-may-2026).
    const phoneInternational = aucoClient.normalizePhoneToInternational(input.telefono_firmante);
    if (!phoneInternational) {
      logger.warn(
        { telefono: input.telefono_firmante, contratoId: c.id },
        'Telefono ausente o no normalizable — no se puede iniciar firma por WhatsApp',
      );
      throw AppError.badRequest(
        'Para enviar el contrato a firma se requiere un teléfono válido del firmante. La firma se realiza por WhatsApp.',
        'TELEFONO_REQUERIDO_PARA_FIRMA',
      );
    }
    enableWhatsapp = true;

    // Globales OTP por email solo cuando NO hay flow por WhatsApp. Cuando
    // enableWhatsapp=true, el signProfile individual ya define otpCode:'phone'
    // y mezclar globales puede causar el error generico de Auco "Se ha
    // producido un error inesperado" al iniciar el flujo en WhatsApp.
    const baseUploadInput = {
      email: env.AUCO_SENDER_EMAIL,
      name: processName,
      subject: `Firma de contrato de arrendamiento - ${direccionInmueble}${ciudadInmueble ? `, ${ciudadInmueble}` : ''}`,
      message: `Estimado/a ${input.nombre_firmante}, se le invita a revisar y firmar el contrato de arrendamiento del inmueble ubicado en ${direccionInmueble}${ciudadInmueble ? `, ${ciudadInmueble}` : ''}. Por favor revise el documento y proceda con la firma electrónica.`,
      file: pdfBase64,
      signProfile: [
        buildSignProfile({
          name: input.nombre_firmante,
          email: input.email_firmante,
          phoneInternational,
          identification: solicitanteIdentification,
          identificationType: solicitanteIdentificationType,
          country: solicitanteCountry,
        }),
      ],
      expiredDate: tokenExpiracion,
      // Auco rechaza el campo `webhooks` con 400 — los webhooks se configuran
      // a nivel de cuenta en el panel y se aplican automaticamente.
    };

    // Logging defensivo del payload Auco — sin el `file` para no inflar logs
    // ni filtrar contenido. Util para diagnosticar fallos del flow WhatsApp
    // donde Auco recibe el doc pero no lo asocia al numero correctamente.
    const pdfSizeBytes = buffer.length;
    const pdfSizeBase64Bytes = pdfBase64.length;
    logger.info(
      {
        contratoId: c.id,
        pdfSizeBytes,
        pdfSizeBase64Bytes,
        pdfSizeKB: (pdfSizeBytes / 1024).toFixed(1),
        senderEmail: baseUploadInput.email,
        processName,
        signProfile: baseUploadInput.signProfile,
        expiredDate: baseUploadInput.expiredDate,
        whatsappFlow: enableWhatsapp,
      },
      'Auco upload: payload preparado (sin file)',
    );

    aucoDocumentCode = await aucoClient.uploadDocumentForSignature(baseUploadInput);
    logger.info(
      { contratoId: c.id, documentCode: aucoDocumentCode, pdfSizeKB: (pdfSizeBytes / 1024).toFixed(1) },
      'Auco: documento subido — flow del firmante por WhatsApp (OTP por phone)',
    );
  } catch (aucoError) {
    logger.error({ error: aucoError, contratoId: c.id }, 'Error al enviar documento a Auco');
    // Mario (7-may-2026): el flujo es WhatsApp puro. Si Auco falla (creditos
    // agotados, plan vencido, etc.) NO creamos la solicitud con un email
    // alterno — propagamos el error para que el propietario lo vea y decida.
    const detalle = aucoError instanceof Error ? aucoError.message : String(aucoError);
    throw AppError.badRequest(
      `No fue posible enviar el contrato a firma por WhatsApp. Verifica el estado de la cuenta de Auco y reintenta. Detalle: ${detalle}`,
      'AUCO_UPLOAD_FAILED',
    );
  }

  // 5. Insert solicitud
  const { data: solicitud, error: insertError } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .insert({
      contrato_id: input.contrato_id,
      nombre_firmante: input.nombre_firmante,
      email_firmante: input.email_firmante,
      telefono_firmante: input.telefono_firmante || null,
      token,
      token_expiracion: tokenExpiracion,
      estado: 'enviado',
      envios_realizados: 1,
      max_envios: MAX_ENVIOS_DEFAULT,
      enviado_por: userId,
      auco_document_code: aucoDocumentCode,
    } as never)
    .select(SOLICITUD_SELECT)
    .single();

  if (insertError || !solicitud) {
    logger.error({ error: insertError?.message }, 'Error al crear solicitud de firma');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear la solicitud de firma');
  }

  const row = solicitud as unknown as SolicitudFirmaRow;

  // 6. La notificacion al firmante la maneja Auco por WhatsApp. Mantenemos
  // firmaUrl solo para logs/respuesta del endpoint; el firmante NO recibe un
  // correo de Cofianza con ese link — Mario (7-may-2026) decidio que el
  // proceso es 100% WhatsApp.
  const firmaUrl = `${env.FRONTEND_URL}/firma/${token}`;
  logger.info(
    { solicitudId: row.id, aucoDocumentCode },
    'Solicitud de firma creada — notificacion al firmante via Auco WhatsApp',
  );

  // 7. Audit log
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.FIRMA_SOLICITUD_CREATED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: input.contrato_id,
    detalle: {
      solicitud_id: row.id,
      email_firmante: input.email_firmante,
      nombre_firmante: input.nombre_firmante,
      auco_document_code: aucoDocumentCode,
    },
    ip,
  });

  // Notificacion in-app al firmante: ya hay contrato listo para firmar.
  // Auco mando WhatsApp/email a su lado, pero si entra al panel queremos
  // que tambien aparezca en la campana. Fire-and-forget.
  findPerfilIdByEmail(input.email_firmante).then((firmanteUserId) => {
    if (!firmanteUserId) return;
    return notificarUsuario({
      userId: firmanteUserId,
      tipo: 'contrato.pendiente_firma',
      titulo: 'Contrato listo para firmar',
      mensaje: `El contrato del inmueble en ${direccionInmueble || 'tu inmueble'} está listo. Recibiste el link de firma por WhatsApp.`,
      link: `/expedientes/${c.expediente_id}`,
      payload: { contrato_id: input.contrato_id, expediente_id: c.expediente_id, solicitud_id: row.id },
    });
  }).catch((e) => logger.warn({ error: e, solicitudId: row.id }, 'Error notificando contrato pendiente de firma'));

  return {
    ...row,
    firma_url: firmaUrl,
  };
}

// ============================================================
// Reenviar link (nuevo token + Auco reminder)
// ============================================================

export async function reenviarSolicitudFirma(
  solicitudId: string,
  userId: string,
  ip?: string,
  emailAlternativo?: string,
) {
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select(`${SOLICITUD_SELECT}, contratos(expediente_id, storage_key, nombre_archivo, expedientes(numero, inmuebles(direccion, ciudad), solicitantes(tipo_documento, numero_documento)))`)
    .eq('id', solicitudId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Solicitud de firma no encontrada', 'SOLICITUD_NOT_FOUND');
  }

  const row = data as unknown as SolicitudFirmaRow & {
    contratos: {
      expediente_id: string;
      storage_key: string | null;
      nombre_archivo: string | null;
      expedientes: {
        numero: string;
        inmuebles: { direccion: string; ciudad: string } | null;
        solicitantes: { tipo_documento: string | null; numero_documento: string | null } | null;
      } | null;
    } | null;
  };

  // Check estado
  if (['firmado', 'cancelado'].includes(row.estado)) {
    throw AppError.badRequest(
      'No se puede reenviar una solicitud en este estado',
      'INVALID_SOLICITUD_STATE',
    );
  }

  // Check max envios
  if (row.envios_realizados >= row.max_envios) {
    throw AppError.badRequest(
      `Se alcanzó el máximo de envíos permitidos (${row.max_envios})`,
      'MAX_ENVIOS_REACHED',
    );
  }

  // Detectar si el caller pidio dirigir el correo a otra direccion. Solo
  // consideramos "cambio" si el email viene y es distinto al actual
  // (case-insensitive). Cambiar el email implica re-subir el documento a
  // Auco con el nuevo firmante porque Auco no permite editar un sobre
  // existente.
  const emailNuevoNormalizado = emailAlternativo?.trim().toLowerCase();
  const emailActualNormalizado = row.email_firmante.trim().toLowerCase();
  const cambiaEmail =
    !!emailNuevoNormalizado && emailNuevoNormalizado !== emailActualNormalizado;

  let nuevoAucoDocumentCode: string | null = row.auco_document_code;
  // Para decidir si enviar email de fallback al final: si Auco WhatsApp
  // sigue activo, no enviamos. Por defecto asumimos activo si la solicitud
  // tenia auco_document_code (creacion previa exitosa) Y el telefono se
  // puede normalizar.
  let aucoWhatsappActivo =
    Boolean(row.auco_document_code)
    && Boolean(aucoClient.normalizePhoneToInternational(row.telefono_firmante || undefined));

  if (cambiaEmail && row.contratos?.storage_key) {
    // Re-upload a Auco con nuevo firmante. Si el documento Auco previo
    // sigue activo, queda obsoleto pero no lo cancelamos explicitamente
    // (Auco lo invalida por expiracion del token y el OTP del nuevo
    // documento es lo unico que la persona usara).
    try {
      const { data: pdfData, error: downloadError } = await supabase.storage
        .from(BUCKET_NAME)
        .download(row.contratos.storage_key);

      if (downloadError || !pdfData) {
        throw new Error(downloadError?.message || 'No se pudo descargar el PDF para re-envio');
      }

      const buffer = Buffer.from(await pdfData.arrayBuffer());
      const pdfBase64 = aucoClient.bufferToBase64(buffer);
      const direccion = row.contratos?.expedientes?.inmuebles?.direccion || 'N/A';
      const ciudad = row.contratos?.expedientes?.inmuebles?.ciudad || '';
      const processName = `Contrato - ${row.contratos?.expedientes?.numero || row.contrato_id}`;

      // Reenvio a otro correo: mantenemos el telefono original (el que
      // sirvio en la creacion) para que Auco mande el WhatsApp al mismo
      // numero pero con la nueva direccion de correo asociada al firmante.
      // Mario (7-may-2026): el proceso es 100% WhatsApp; sin telefono valido
      // no se puede reenviar.
      const phoneInternational = aucoClient.normalizePhoneToInternational(row.telefono_firmante || undefined);
      if (!phoneInternational) {
        throw AppError.badRequest(
          'No se puede reenviar la firma a otro correo porque la solicitud original no tiene un telefono valido. La firma se hace por WhatsApp.',
          'TELEFONO_REQUERIDO_PARA_FIRMA',
        );
      }

      const baseReuploadInput = {
        email: env.AUCO_SENDER_EMAIL,
        name: processName,
        subject: `Firma de contrato de arrendamiento - ${direccion}${ciudad ? `, ${ciudad}` : ''}`,
        message: `Estimado/a ${row.nombre_firmante}, se le invita a revisar y firmar el contrato de arrendamiento del inmueble ubicado en ${direccion}${ciudad ? `, ${ciudad}` : ''}. Por favor revise el documento y proceda con la firma electrónica.`,
        file: pdfBase64,
        signProfile: [
          buildSignProfile({
            name: row.nombre_firmante,
            email: emailNuevoNormalizado!,
            phoneInternational,
            identification: row.contratos?.expedientes?.solicitantes?.numero_documento ?? null,
            identificationType: row.contratos?.expedientes?.solicitantes?.tipo_documento ?? null,
            country: 'CO',
          }),
        ],
        expiredDate: new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000).toISOString(),
        // webhooks se configuran a nivel de cuenta en el panel de Auco.
      };

      nuevoAucoDocumentCode = await aucoClient.uploadDocumentForSignature(baseReuploadInput);
      aucoWhatsappActivo = Boolean(nuevoAucoDocumentCode);

      logger.info(
        { solicitudId, oldEmail: emailActualNormalizado, newEmail: emailNuevoNormalizado, nuevoAucoDocumentCode },
        'Auco: re-upload del documento con nuevo firmante completado',
      );
    } catch (aucoError) {
      logger.error(
        { error: aucoError, solicitudId, emailNuevo: emailNuevoNormalizado },
        'Error al re-subir documento a Auco con nuevo email',
      );
      const detalle = aucoError instanceof Error ? aucoError.message : String(aucoError);
      throw AppError.badRequest(
        `No fue posible reenviar el contrato a firma por WhatsApp con el nuevo correo. Verifica el estado de la cuenta de Auco y reintenta. Detalle: ${detalle}`,
        'AUCO_UPLOAD_FAILED',
      );
    }
  } else if (row.auco_document_code) {
    // Caso normal (mismo email): pedirle a Auco que reenvie recordatorio.
    try {
      await aucoClient.sendReminder(row.auco_document_code);
    } catch (aucoError) {
      logger.error({ error: aucoError, solicitudId }, 'Error al enviar recordatorio via Auco');
    }
  }

  // Generate new token
  const newToken = crypto.randomBytes(32).toString('hex');
  const newExpiration = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

  // Update — incluye email_firmante nuevo y auco_document_code nuevo si aplica.
  const updatePayload: Record<string, unknown> = {
    token: newToken,
    token_expiracion: newExpiration,
    estado: 'enviado',
    envios_realizados: row.envios_realizados + 1,
    updated_at: new Date().toISOString(),
  };
  if (cambiaEmail) {
    updatePayload.email_firmante = emailNuevoNormalizado;
    updatePayload.auco_document_code = nuevoAucoDocumentCode;
  }

  const { data: updated, error: updateError } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .update(updatePayload as never)
    .eq('id', solicitudId)
    .select(SOLICITUD_SELECT)
    .single();

  if (updateError || !updated) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al reenviar la solicitud');
  }

  // Reenvio: la notificacion la maneja Auco (sendReminder o re-upload). No
  // mandamos correo custom — el flujo es WhatsApp puro (Mario, 7-may-2026).
  const emailDestino = cambiaEmail ? emailNuevoNormalizado! : row.email_firmante;
  logger.info(
    { solicitudId, aucoWhatsappActivo },
    'Reenvio de solicitud de firma — notificacion al firmante via Auco WhatsApp',
  );

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.FIRMA_SOLICITUD_RESENT,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: row.contrato_id,
    detalle: {
      solicitud_id: solicitudId,
      envio_numero: row.envios_realizados + 1,
      email_destino: emailDestino,
      cambio_email: cambiaEmail,
    },
    ip,
  });

  return updated as unknown as SolicitudFirmaRow;
}

/**
 * Reenvio "self": el solicitante autenticado dueno del expediente puede
 * pedir reenvio del correo de firma (al mismo email o a otro alternativo).
 * Verifica pertenencia: la solicitud debe ser de un contrato cuyo
 * expediente.solicitante_id == perfil del usuario autenticado.
 */
export async function reenviarSolicitudFirmaSelf(
  solicitudId: string,
  userId: string,
  ip?: string,
  emailAlternativo?: string,
) {
  // 1. Verificar que la solicitud existe y traer la cadena hasta solicitante.
  const { data: solRow, error: solError } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, contratos!inner(expediente_id, expedientes!inner(solicitante_id))')
    .eq('id', solicitudId)
    .single();

  if (solError || !solRow) {
    throw AppError.notFound('Solicitud de firma no encontrada', 'SOLICITUD_NOT_FOUND');
  }

  const sol = solRow as unknown as {
    id: string;
    contrato_id: string;
    contratos: {
      expediente_id: string;
      expedientes: { solicitante_id: string | null };
    };
  };

  const solicitanteId = sol.contratos?.expedientes?.solicitante_id;
  if (!solicitanteId) {
    throw AppError.forbidden('Solicitud sin solicitante asociado', 'NO_SOLICITANTE');
  }

  // 2. El usuario autenticado debe ser el solicitante. La tabla
  //    solicitantes tiene una columna 'creado_por' que apunta al
  //    perfil que creo el solicitante (en flujo self-service es el
  //    propio user.id), pero el id real del solicitante es otro UUID.
  //    Para resolver: el JWT del solicitante autenticado tiene user.id
  //    igual a perfiles.id; el solicitantes.creado_por es ese mismo id
  //    cuando el solicitante creo el perfil via wizard.
  const { data: solicitante } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select('id, creado_por')
    .eq('id', solicitanteId)
    .maybeSingle();

  const owner = (solicitante as { creado_por?: string | null } | null)?.creado_por;
  if (owner !== userId) {
    throw AppError.forbidden(
      'No tienes permisos para reenviar esta solicitud de firma',
      'NOT_OWNER',
    );
  }

  // 3. Reusar el flujo principal con el email alternativo opcional.
  return reenviarSolicitudFirma(solicitudId, userId, ip, emailAlternativo);
}

// ============================================================
// Consultar estado de una solicitud
// ============================================================

export async function getSolicitud(solicitudId: string) {
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select(`${SOLICITUD_SELECT}, perfiles(id, nombre, apellido)`)
    .eq('id', solicitudId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Solicitud de firma no encontrada', 'SOLICITUD_NOT_FOUND');
  }

  const row = data as unknown as SolicitudFirmaRow & {
    perfiles: { id: string; nombre: string; apellido: string } | null;
  };

  return {
    ...row,
    enviado_por_nombre: row.perfiles
      ? `${row.perfiles.nombre} ${row.perfiles.apellido}`
      : null,
    token: undefined, // Don't expose token
    perfiles: undefined,
  };
}

// ============================================================
// Listar solicitudes de un contrato
// ============================================================

export async function listarSolicitudes(contratoId: string) {
  // Verify contrato exists
  const { data: contrato } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', contratoId)
    .single();

  if (!contrato) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select(`${SOLICITUD_SELECT}, perfiles(id, nombre, apellido)`)
    .eq('contrato_id', contratoId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error: error.message, contratoId }, 'Error al listar solicitudes de firma');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener las solicitudes');
  }

  const solicitudes = (data ?? []).map((row: unknown) => {
    const r = row as SolicitudFirmaRow & {
      perfiles: { id: string; nombre: string; apellido: string } | null;
    };
    return {
      id: r.id,
      contrato_id: r.contrato_id,
      nombre_firmante: r.nombre_firmante,
      email_firmante: r.email_firmante,
      telefono_firmante: r.telefono_firmante,
      estado: r.estado,
      envios_realizados: r.envios_realizados,
      max_envios: r.max_envios,
      token_expiracion: r.token_expiracion,
      abierto_en: r.abierto_en,
      firmado_en: r.firmado_en,
      auco_document_code: r.auco_document_code,
      created_at: r.created_at,
      updated_at: r.updated_at,
      enviado_por_nombre: r.perfiles
        ? `${r.perfiles.nombre} ${r.perfiles.apellido}`
        : null,
    };
  });

  return { solicitudes };
}

// ============================================================
// Cancelar solicitud (+ cancelar en Auco)
// ============================================================

export async function cancelarSolicitud(
  solicitudId: string,
  userId: string,
  ip?: string,
) {
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, estado, auco_document_code')
    .eq('id', solicitudId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Solicitud no encontrada', 'SOLICITUD_NOT_FOUND');
  }

  const row = data as unknown as {
    id: string; contrato_id: string; estado: string; auco_document_code: string | null;
  };

  if (['firmado', 'cancelado'].includes(row.estado)) {
    throw AppError.badRequest('No se puede cancelar esta solicitud', 'INVALID_STATE');
  }

  // Cancel in Auco if document code exists
  if (row.auco_document_code) {
    try {
      await aucoClient.cancelDocument(row.auco_document_code);
    } catch (aucoError) {
      logger.error({ error: aucoError, solicitudId }, 'Error al cancelar documento en Auco');
    }
  }

  const { error: updateError } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'cancelado',
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', solicitudId);

  if (updateError) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al cancelar la solicitud');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.FIRMA_SOLICITUD_CANCELLED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: row.contrato_id,
    detalle: { solicitud_id: solicitudId },
    ip,
  });
}

// ============================================================
// Validar token (para pagina publica)
// ============================================================

export async function validarToken(token: string) {
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, nombre_firmante, email_firmante, estado, token_expiracion')
    .eq('token', token)
    .single();

  if (error || !data) {
    throw AppError.notFound('Enlace de firma no válido', 'INVALID_TOKEN');
  }

  const row = data as unknown as {
    id: string;
    contrato_id: string;
    nombre_firmante: string;
    email_firmante: string;
    estado: string;
    token_expiracion: string;
  };

  // Check expiration
  if (new Date(row.token_expiracion) < new Date()) {
    if (row.estado !== 'expirado' && row.estado !== 'firmado' && row.estado !== 'cancelado') {
      await (supabase
        .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
        .update({ estado: 'expirado', updated_at: new Date().toISOString() } as never)
        .eq('id', row.id);
    }
    throw AppError.badRequest('El enlace de firma ha expirado', 'TOKEN_EXPIRED');
  }

  if (['firmado', 'cancelado', 'expirado'].includes(row.estado)) {
    throw AppError.badRequest(
      row.estado === 'firmado'
        ? 'Este contrato ya fue firmado'
        : 'Este enlace ya no es válido',
      'INVALID_TOKEN_STATE',
    );
  }

  // Mark as opened if first time
  if (row.estado === 'enviado') {
    await (supabase
      .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
      .update({
        estado: 'abierto',
        abierto_en: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never)
      .eq('id', row.id);
  }

  // Fetch contrato + expediente info for display
  const { data: contratoData } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, nombre_archivo, expedientes(numero, inmuebles(direccion, ciudad))')
    .eq('id', row.contrato_id)
    .single();

  const cc = contratoData as unknown as {
    id: string;
    nombre_archivo: string | null;
    expedientes: {
      numero: string;
      inmuebles: { direccion: string; ciudad: string } | null;
    } | null;
  } | null;

  return {
    solicitud_id: row.id,
    nombre_firmante: row.nombre_firmante,
    email_firmante: row.email_firmante,
    estado: row.estado === 'enviado' ? 'abierto' : row.estado,
    token_expiracion: row.token_expiracion,
    contrato_nombre: cc?.nombre_archivo || 'Contrato',
    expediente_numero: cc?.expedientes?.numero || '',
    inmueble_direccion: cc?.expedientes?.inmuebles?.direccion || '',
    inmueble_ciudad: cc?.expedientes?.inmuebles?.ciudad || '',
  };
}

// ============================================================
// Get contract PDF for public signing page (HP-342)
// ============================================================

const PDF_URL_EXPIRY_SECONDS = 600; // 10 minutes

export async function getContratoPdf(token: string) {
  // Validate token first
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, estado, token_expiracion')
    .eq('token', token)
    .single();

  if (error || !data) {
    throw AppError.notFound('Enlace de firma no válido', 'INVALID_TOKEN');
  }

  const row = data as unknown as {
    id: string;
    contrato_id: string;
    estado: string;
    token_expiracion: string;
  };

  // Check expiration
  if (new Date(row.token_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de firma ha expirado', 'TOKEN_EXPIRED');
  }

  // Check state
  if (['firmado', 'cancelado', 'expirado'].includes(row.estado)) {
    throw AppError.badRequest('Este enlace ya no es válido', 'INVALID_TOKEN_STATE');
  }

  // Get contract storage_key
  const { data: contratoData, error: contratoError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, storage_key, nombre_archivo')
    .eq('id', row.contrato_id)
    .single();

  if (contratoError || !contratoData) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  const contrato = contratoData as unknown as {
    id: string;
    storage_key: string | null;
    nombre_archivo: string | null;
  };

  if (!contrato.storage_key) {
    throw AppError.badRequest('El contrato no tiene PDF generado', 'NO_PDF');
  }

  // Generate signed URL (read-only, no download header)
  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(contrato.storage_key, PDF_URL_EXPIRY_SECONDS);

  if (urlError || !urlData?.signedUrl) {
    logger.error({ error: urlError, storageKey: contrato.storage_key }, 'Error creating signed URL for PDF');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener el PDF');
  }

  return {
    pdf_url: urlData.signedUrl,
    nombre_archivo: contrato.nombre_archivo || 'contrato.pdf',
    expira_en_segundos: PDF_URL_EXPIRY_SECONDS,
  };
}

// ============================================================
// Auco Webhook Handler
// ============================================================

/**
 * Process incoming webhook notifications from Auco.
 * Maps Auco statuses to our internal solicitud states:
 *   NOTIFICATION → abierto (signer was notified / opened)
 *   FINISH       → firmado (all signers completed)
 *   REJECTED     → cancelado (signer rejected)
 *   BLOCKED      → cancelado (too many failed attempts)
 *   EXPIRED      → expirado (past deadline)
 */
export async function handleAucoWebhook(payload: AucoWebhookPayload) {
  const { code, status, url: signedUrl } = payload;

  logger.info({ code, status }, 'Auco webhook received');

  // Find solicitud by auco_document_code
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, estado, nombre_firmante, email_firmante')
    .eq('auco_document_code', code)
    .single();

  if (error || !data) {
    logger.warn({ code }, 'Auco webhook: solicitud not found for document code');
    return;
  }

  const row = data as unknown as {
    id: string;
    contrato_id: string;
    estado: string;
    nombre_firmante: string;
    email_firmante: string;
  };

  // Multi-parte (M1): si el contrato tiene firmantes registrados, el estado por
  // parte vive en contrato_firmantes — delegamos a la reconciliación por poll
  // (que casa cada firmante con signProfile[] de Auco). El webhook de documento
  // solo actúa de disparador.
  const { data: cfRows } = await (supabase
    .from('contrato_firmantes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('contrato_id', row.contrato_id)
    .limit(1);
  if (cfRows && (cfRows as unknown[]).length > 0) {
    const { reconciliarFirmantesConAuco } = await import('./firma-multiparte.service');
    await reconciliarFirmantesConAuco(row.contrato_id).catch((err) =>
      logger.error({ error: err, contratoId: row.contrato_id }, 'Auco webhook: error reconciliando multi-parte'),
    );
    return;
  }

  // Don't update if already in terminal state
  if (['firmado', 'cancelado', 'expirado'].includes(row.estado)) {
    logger.debug({ id: row.id, estado: row.estado, aucoStatus: status }, 'Auco webhook: solicitud already in terminal state');
    return;
  }

  const now = new Date().toISOString();
  let newEstado: string | null = null;
  const updateFields: Record<string, unknown> = { updated_at: now };

  switch (status) {
    case 'NOTIFICATION':
      if (row.estado === 'enviado' || row.estado === 'pendiente') {
        newEstado = 'abierto';
        updateFields.abierto_en = now;
      }
      break;

    case 'FINISH':
      newEstado = 'firmado';
      updateFields.firmado_en = now;
      if (signedUrl) {
        updateFields.auco_signed_url = signedUrl;
      }
      break;

    case 'REJECTED':
    case 'REJECT':
    case 'BLOCKED':
      newEstado = 'cancelado';
      break;

    case 'EXPIRED':
      newEstado = 'expirado';
      break;

    default:
      logger.debug({ code, status }, 'Auco webhook: unhandled status');
      return;
  }

  if (newEstado) {
    updateFields.estado = newEstado;

    await (supabase
      .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
      .update(updateFields as never)
      .eq('id', row.id);

    logger.info(
      { solicitudId: row.id, oldEstado: row.estado, newEstado, aucoStatus: status },
      'Solicitud de firma updated via Auco webhook',
    );

    if (newEstado === 'firmado') {
      logAudit({
        usuarioId: null,
        accion: AUDIT_ACTIONS.FIRMA_AUCO_SIGNED,
        entidad: AUDIT_ENTITIES.CONTRATO,
        entidadId: row.contrato_id,
        detalle: {
          solicitud_id: row.id,
          auco_code: code,
          signed_url: signedUrl,
        },
      });

      // Cierra el bucle: transicion del contrato a firmado, evento timeline,
      // emails de acuse al firmante y al operador. Sin esto, la firma via
      // Auco webhook quedaba "huerfana" y dependia del auto-heal manual al
      // entrar a la pestaña Contratos. Fire-and-forget — los errores se
      // loggean pero no bloquean la respuesta del webhook.
      const { executePostFirma } = await import('./post-firma.service');
      executePostFirma({
        solicitudId: row.id,
        contratoId: row.contrato_id,
        nombreFirmante: row.nombre_firmante,
        emailFirmante: row.email_firmante,
        firmadoEn: now,
      }).catch((err) => {
        logger.error(
          { error: err, solicitudId: row.id },
          'Auco webhook: error en executePostFirma',
        );
      });
    }
  }
}

// ============================================================
// Sincronizar estado de firma desde Auco (fallback al webhook)
// ============================================================
/**
 * Si el webhook de Auco no llega (eg. webhook no configurado en el panel,
 * red caida, deploy timing), pollea Auco directamente para todos los
 * contratos en `pendiente_firma` del expediente. Si Auco dice que el
 * documento esta FINISH, actualiza la solicitud_firma local y dispara
 * executePostFirma.
 *
 * Idempotente — si ya esta en estado terminal, no hace nada.
 *
 * Llamada fire-and-forget desde getExpedienteById para que el simple acto
 * de abrir el expediente cierre la firma cuando el webhook no llego.
 */
export async function syncFirmaConAucoForExpediente(expedienteId: string): Promise<void> {
  logger.info({ expedienteId }, 'syncFirmaConAuco: ENTRY');

  // 1. Encontrar contratos del expediente en pendiente_firma con auco_code.
  const { data: contratosRow, error: contratosErr } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .eq('estado', 'pendiente_firma');

  if (contratosErr) {
    logger.error({ expedienteId, error: contratosErr.message }, 'syncFirmaConAuco: error consultando contratos');
    return;
  }

  const contratos = (contratosRow as Array<{ id: string; estado: string }> | null) || [];
  logger.info({ expedienteId, contratos: contratos.length }, 'syncFirmaConAuco: contratos pendiente_firma');
  if (contratos.length === 0) return;

  for (const contrato of contratos) {
    // Multi-parte (M1): si el contrato tiene firmantes registrados, delegamos a
    // la reconciliación por parte y saltamos el flujo de un solo firmante.
    const { data: cfRows } = await (supabase
      .from('contrato_firmantes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('contrato_id', contrato.id)
      .limit(1);
    if (cfRows && (cfRows as unknown[]).length > 0) {
      const { reconciliarFirmantesConAuco } = await import('./firma-multiparte.service');
      await reconciliarFirmantesConAuco(contrato.id).catch((err) =>
        logger.error({ error: err, contratoId: contrato.id }, 'syncFirmaConAuco: error reconciliando multi-parte'),
      );
      continue;
    }

    // 2. Encontrar solicitudes_firma del contrato. Filtramos en JS para
    //    evitar la sintaxis fragil de .not('estado','in',...) de Supabase
    //    (que silently no matchea y nos hacia ignorar todas las solicitudes).
    const { data: solRow, error: solErr } = await (supabase
      .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado, auco_document_code, nombre_firmante, email_firmante, contrato_id')
      .eq('contrato_id', contrato.id);

    if (solErr) {
      logger.error({ contratoId: contrato.id, error: solErr.message }, 'syncFirmaConAuco: error consultando solicitudes_firma');
      continue;
    }

    const todas = (solRow as Array<{
      id: string;
      estado: string;
      auco_document_code: string | null;
      nombre_firmante: string;
      email_firmante: string;
      contrato_id: string;
    }> | null) || [];

    const TERMINAL = ['firmado', 'cancelado', 'expirado'];
    const solicitudes = todas.filter(
      (s) => !!s.auco_document_code && !TERMINAL.includes(s.estado),
    ) as Array<{
      id: string;
      estado: string;
      auco_document_code: string;
      nombre_firmante: string;
      email_firmante: string;
      contrato_id: string;
    }>;

    logger.info(
      {
        contratoId: contrato.id,
        totalSolicitudes: todas.length,
        solicitudesActivas: solicitudes.length,
        estados: todas.map((s) => s.estado),
      },
      'syncFirmaConAuco: solicitudes inspeccionadas',
    );

    if (solicitudes.length === 0) continue;

    for (const sol of solicitudes) {
      try {
        const info = await aucoClient.getDocumentStatus(sol.auco_document_code);
        logger.info(
          {
            solicitudId: sol.id,
            aucoCode: sol.auco_document_code,
            aucoStatus: info.status,
            aucoSignersStatuses: info.signProfile?.map((s) => ({ name: s.name, status: s.status })),
            aucoUrlPresent: !!info.url,
            aucoRaw: info,
          },
          'syncFirmaConAuco: respuesta Auco',
        );
        if (info.status !== 'FINISH') continue;

        // 3. Actualizar la solicitud localmente — usamos la URL firmada de Auco
        //    y registramos el momento. Idempotencia: si por race condition ya
        //    quedo firmado, el SELECT siguiente lo va a saltar.
        const now = new Date().toISOString();
        await (supabase
          .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
          .update({
            estado: 'firmado',
            firmado_en: now,
            auco_signed_url: info.url ?? null,
            updated_at: now,
          } as never)
          .eq('id', sol.id);

        logger.info(
          { solicitudId: sol.id, contratoId: sol.contrato_id, expedienteId, aucoCode: sol.auco_document_code },
          'syncFirmaConAuco: solicitud sincronizada como firmada (poll, sin webhook)',
        );

        logAudit({
          usuarioId: null,
          accion: AUDIT_ACTIONS.FIRMA_AUCO_SIGNED,
          entidad: AUDIT_ENTITIES.CONTRATO,
          entidadId: sol.contrato_id,
          detalle: {
            solicitud_id: sol.id,
            auco_code: sol.auco_document_code,
            signed_url: info.url,
            origen: 'poll',
          },
        });

        // 4. Disparar el flow post-firma (transicion contrato + emails + timeline).
        const { executePostFirma } = await import('./post-firma.service');
        executePostFirma({
          solicitudId: sol.id,
          contratoId: sol.contrato_id,
          nombreFirmante: sol.nombre_firmante,
          emailFirmante: sol.email_firmante,
          firmadoEn: now,
        }).catch((err) => {
          logger.error(
            { error: err, solicitudId: sol.id },
            'syncFirmaConAuco: error en executePostFirma',
          );
        });
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err), solicitudId: sol.id },
          'syncFirmaConAuco: error al consultar Auco — se reintenta en la siguiente carga',
        );
      }
    }
  }
}

// ============================================================
// Archivar PDF firmado por Auco al Storage
// ============================================================
/**
 * Descarga el PDF firmado desde la signed URL que Auco devuelve en el
 * webhook FINISH y lo sube a nuestro bucket. Asi el "Descargar contrato"
 * baja el PDF con certificado/hash/OTP en lugar del original sin firma.
 *
 * Idempotente: si el contrato ya tiene `storage_key_firmado`, no hace
 * nada. Si la signed URL de Auco ya expiró, falla silenciosamente para
 * que el contrato siga accesible (al menos en su version sin firma).
 */
export async function archivarPdfFirmadoEnStorage(contratoId: string): Promise<void> {
  // 1. Verificar que el contrato no tenga ya un storage_key_firmado.
  const { data: contratoRow } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, version, storage_key_firmado, expedientes(numero)')
    .eq('id', contratoId)
    .single();

  const contrato = contratoRow as unknown as {
    id: string;
    expediente_id: string;
    version: number;
    storage_key_firmado: string | null;
    expedientes: { numero: string } | null;
  } | null;

  if (!contrato) {
    logger.warn({ contratoId }, 'archivarPdfFirmado: contrato no encontrado');
    return;
  }

  if (contrato.storage_key_firmado) {
    logger.debug({ contratoId }, 'archivarPdfFirmado: ya archivado, skip');
    return;
  }

  // 2. Buscar la solicitud_firma con auco_signed_url.
  const { data: solRow } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, auco_signed_url, auco_document_code')
    .eq('contrato_id', contratoId)
    .eq('estado', 'firmado')
    .not('auco_signed_url', 'is', null)
    .order('firmado_en', { ascending: false })
    .limit(1)
    .maybeSingle();

  const sol = solRow as unknown as {
    id: string;
    auco_signed_url: string;
    auco_document_code: string;
  } | null;

  if (!sol?.auco_signed_url) {
    logger.warn({ contratoId }, 'archivarPdfFirmado: no hay auco_signed_url disponible');
    return;
  }

  // 3. Descargar el PDF desde Auco.
  let pdfBuffer: Buffer;
  try {
    const resp = await fetch(sol.auco_signed_url);
    if (!resp.ok) {
      logger.warn(
        { contratoId, status: resp.status },
        'archivarPdfFirmado: descarga del PDF firmado fallo (URL Auco probablemente expiro)',
      );
      return;
    }
    const arrayBuf = await resp.arrayBuffer();
    pdfBuffer = Buffer.from(arrayBuf);
  } catch (err) {
    logger.warn(
      { contratoId, error: err instanceof Error ? err.message : String(err) },
      'archivarPdfFirmado: error descargando PDF',
    );
    return;
  }

  // 4. Subir al bucket. Path: contratos-firmados/{expediente_id}/{contrato_id}-v{version}.pdf
  const storageKey = `contratos-firmados/${contrato.expediente_id}/${contrato.id}-v${contrato.version}.pdf`;
  const numeroExp = contrato.expedientes?.numero || contrato.id.slice(0, 8);
  const nombreArchivo = `contrato-${numeroExp}-firmado-v${contrato.version}.pdf`;

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storageKey, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadErr) {
    logger.error(
      { contratoId, storageKey, error: uploadErr.message },
      'archivarPdfFirmado: error subiendo al bucket',
    );
    return;
  }

  // 5. Persistir storage_key_firmado y nombre.
  const { error: updErr } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .update({
      storage_key_firmado: storageKey,
      nombre_archivo_firmado: nombreArchivo,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', contratoId);

  if (updErr) {
    logger.error({ contratoId, error: updErr.message }, 'archivarPdfFirmado: error guardando referencia en DB');
    return;
  }

  logger.info(
    { contratoId, storageKey, sizeBytes: pdfBuffer.length },
    'archivarPdfFirmado: PDF firmado archivado en Storage',
  );
}

// ============================================================
// Bulk token expiration (cron)
// ============================================================

export async function expirarSolicitudesVencidas(): Promise<{ expiradas: number }> {
  const now = new Date().toISOString();

  // Find all solicitudes with expired tokens that are still in active states
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id')
    .in('estado', ['pendiente', 'enviado', 'abierto', 'otp_validado'])
    .lt('token_expiracion', now);

  if (error) {
    logger.error({ error: error.message }, 'Error al buscar solicitudes expiradas');
    return { expiradas: 0 };
  }

  const rows = (data as unknown as { id: string; contrato_id: string }[]) || [];

  if (rows.length === 0) {
    return { expiradas: 0 };
  }

  const ids = rows.map((r) => r.id);

  const { error: updateError } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'expirado', updated_at: new Date().toISOString() } as never)
    .in('id', ids);

  if (updateError) {
    logger.error({ error: updateError.message }, 'Error al expirar solicitudes en bulk');
    return { expiradas: 0 };
  }

  logger.info({ count: rows.length, ids }, 'Solicitudes de firma expiradas por cron');

  return { expiradas: rows.length };
}
