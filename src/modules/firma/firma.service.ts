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
import { assertExpedienteAccess } from '@/lib/tenantScope';
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
  page.drawText(`Estudio: ${params.expedienteNumero}`, {
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
  userRol?: string,
  ip?: string,
) {
  // 1. Validate contrato exists and is in valid state
  const { data: contrato, error: contratoError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, expediente_id, storage_key, nombre_archivo, destinacion, datos_variables')
    .eq('id', input.contrato_id)
    .single();

  if (contratoError || !contrato) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  const c = contrato as unknown as {
    id: string; estado: string; expediente_id: string;
    storage_key: string | null; nombre_archivo: string | null; destinacion: string | null;
    datos_variables: unknown;
  };

  // Guard de pertenencia (IDOR): no-op para roles internos / sin identidad;
  // 404 si el contrato no está en el scope del usuario (inmobiliaria/propietario).
  await assertExpedienteAccess(c.expediente_id, userId, userRol);

  // Contratos V3: su sobre lo crea el asistente (contrato_v3_sobres), nunca este flujo.
  if (c.destinacion) {
    throw AppError.conflict('El envío a firma de este contrato se hace desde el asistente de contratos.', 'CONTRATO_V3_USA_ASISTENTE');
  }

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
  // Una firma completa que llegó sin aviso, antes de que otra guarda la tape.
  await exigirSinFirmaCompleta(c.id, c.expediente_id);

  // 2. Fetch expediente + inmueble + solicitante data
  // El solicitante es necesario para Auco: identification, identificationType
  // y country son requeridos para activar la validacion biometrica
  // (options.camera = 'identification') segun la doc de Auco.
  const { data: expediente } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('numero, inmuebles!expedientes_inmueble_id_fkey(direccion, ciudad), solicitantes(tipo_documento, numero_documento)')
    .eq('id', c.expediente_id)
    .single();

  const exp = expediente as unknown as {
    numero: string;
    inmuebles: { direccion: string; ciudad: string } | null;
    solicitantes: { tipo_documento: string | null; numero_documento: string | null } | null;
  } | null;

  // 3. Generate secure token. Sin co-arrendatario ni co-titular (P6), sin otro
  // sobre vivo, y el plazo de firma de 15 días sin pasar el CRC (P5).
  const token = crypto.randomBytes(32).toString('hex');
  const { assertPuedeAbrirSobre, plazoFirmaContrato } = await import('@/modules/contratos/contratos.service');
  await assertPuedeAbrirSobre(c.id, c.expediente_id, c.datos_variables);
  const tokenExpiracion = await plazoFirmaContrato(c.expediente_id);
  // La solicitud anterior se cierra antes de abrir la nueva, sin perder una firma que llegó sin aviso.
  await anularSobresAnteriores(c.id, c.expediente_id);

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
    // El documento ya está en Auco: si no queda registrado, no puede quedar vivo.
    if (aucoDocumentCode) await anularDocumentoHuerfano(aucoDocumentCode, c.id);
    if ((insertError as { code?: string } | null)?.code === '23505') {
      throw AppError.conflict('Ya hay un envío a firma en curso para este contrato.', 'FIRMA_YA_EN_CURSO');
    }
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
      mensaje: `El contrato de ${direccionInmueble || 'tu inmueble'} está listo. Te enviamos el link de firma por WhatsApp.`,
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
  userRol?: string,
  ip?: string,
  emailAlternativo?: string,
) {
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select(`${SOLICITUD_SELECT}, contratos(expediente_id, storage_key, nombre_archivo, datos_variables, expedientes(numero, inmuebles!expedientes_inmueble_id_fkey(direccion, ciudad), solicitantes(tipo_documento, numero_documento)))`)
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
      datos_variables: unknown;
      expedientes: {
        numero: string;
        inmuebles: { direccion: string; ciudad: string } | null;
        solicitantes: { tipo_documento: string | null; numero_documento: string | null } | null;
      } | null;
    } | null;
  };

  // Guard de pertenencia (IDOR): no-op para roles internos / sin identidad;
  // 404 si el contrato del solicitud no está en el scope del usuario. Se aplica
  // ANTES de tocar Auco (re-upload / recordatorio) o mutar la solicitud.
  await assertExpedienteAccess(row.contratos?.expediente_id ?? '', userId, userRol);

  // Check estado
  if (['firmado', 'cancelado'].includes(row.estado)) {
    throw AppError.badRequest(
      'No se puede reenviar una solicitud en este estado',
      'INVALID_SOLICITUD_STATE',
    );
  }
  // contratos-firma-2: un recordatorio no revive un proceso vencido en Auco.
  if (row.estado === 'expirado' || Date.parse(row.token_expiracion) <= Date.now()) {
    throw AppError.conflict(
      'Venció el plazo para firmar este contrato. Reenvíalo a firma para abrir un plazo nuevo.',
      'FIRMA_VENCIDA',
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

  // Guard multi-parte: la rama de re-upload construye un signProfile de UN
  // solo firmante. Si el contrato tiene sobre multi-parte (filas en
  // contrato_firmantes), re-subir por aquí lo corrompería — el cambio de
  // contacto de un firmante multi-parte requiere recrear el sobre completo.
  if (cambiaEmail) {
    const { count: firmantesMultiparte, error: fmError } = await (supabase
      .from('contrato_firmantes' as string) as ReturnType<typeof supabase.from>)
      .select('id', { count: 'exact', head: true })
      .eq('contrato_id', row.contrato_id);
    // Fail-closed: si no pudimos verificar, NO arriesgamos corromper un sobre
    // multi-parte con un re-upload de un solo firmante.
    if (fmError) {
      logger.error({ error: fmError.message, contratoId: row.contrato_id }, 'No se pudo verificar si el contrato es multi-parte');
      throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo verificar el tipo de firma del contrato. Intenta de nuevo.');
    }
    if ((firmantesMultiparte ?? 0) > 0) {
      // Lo lee sobre todo el arrendatario (su tarjeta): sin jerga interna.
      throw AppError.badRequest(
        'No se puede cambiar el correo de firma desde aquí. Pide a la inmobiliaria o al propietario ' +
          'que actualice tus datos y vuelva a enviar el contrato a firma.',
        'FIRMA_MULTIPARTE_NO_EMAIL_OVERRIDE',
      );
    }
  }

  let nuevoAucoDocumentCode: string | null = row.auco_document_code;
  // Solo un documento nuevo en Auco (otro correo) trae plazo nuevo; un recordatorio no lo mueve.
  let nuevaExpiracion: string | null = null;
  // Para decidir si enviar email de fallback al final: si Auco WhatsApp
  // sigue activo, no enviamos. Por defecto asumimos activo si la solicitud
  // tenia auco_document_code (creacion previa exitosa) Y el telefono se
  // puede normalizar.
  let aucoWhatsappActivo =
    Boolean(row.auco_document_code)
    && Boolean(aucoClient.normalizePhoneToInternational(row.telefono_firmante || undefined));

  if (cambiaEmail && row.contratos?.storage_key) {
    // Un documento nuevo en Auco: las mismas guardas que abrir un sobre (P6 y
    // ningún otro sobre vivo aparte de este), el plazo de firma (P5) y el
    // documento anterior cerrado sin perder una firma que llegó sin aviso.
    if (row.auco_document_code) await leerDocumentoEnAuco(row.contrato_id, row.contratos.expediente_id, row.auco_document_code);
    const { assertPuedeAbrirSobre, plazoFirmaContrato } = await import('@/modules/contratos/contratos.service');
    await assertPuedeAbrirSobre(row.contrato_id, row.contratos.expediente_id, row.contratos.datos_variables, solicitudId);
    nuevaExpiracion = await plazoFirmaContrato(row.contratos.expediente_id);
    // Reenvio a otro correo: mantenemos el telefono original (el que
    // sirvio en la creacion) para que Auco mande el WhatsApp al mismo
    // numero pero con la nueva direccion de correo asociada al firmante.
    // Mario (7-may-2026): el proceso es 100% WhatsApp; sin telefono valido
    // no se puede reenviar. Se valida antes de anular el documento anterior.
    const phoneInternational = aucoClient.normalizePhoneToInternational(row.telefono_firmante || undefined);
    if (!phoneInternational) {
      throw AppError.badRequest(
        'No se puede reenviar la firma a otro correo porque la solicitud original no tiene un telefono valido. La firma se hace por WhatsApp.',
        'TELEFONO_REQUERIDO_PARA_FIRMA',
      );
    }
    const cerradoComo = row.auco_document_code
      ? await cerrarDocumentoAnterior(row.contrato_id, row.contratos.expediente_id, row.auco_document_code)
      : null;
    // Re-upload a Auco con nuevo firmante.
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
        expiredDate: nuevaExpiracion,
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
      // El documento anterior ya quedó anulado: la solicitud no sigue «enviado» apuntándole.
      if (cerradoComo) {
        const { error: cierreError } = await (supabase
          .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
          .update({ estado: cerradoComo, updated_at: new Date().toISOString() } as never)
          .eq('id', solicitudId)
          .eq('auco_document_code', row.auco_document_code);
        if (cierreError) logger.error({ solicitudId, error: cierreError.message }, 'Reenvío a otro correo: no se pudo cerrar la solicitud anulada');
      }
      const detalle = aucoError instanceof Error ? aucoError.message : String(aucoError);
      throw AppError.badRequest(
        `No fue posible reenviar el contrato a firma por WhatsApp con el nuevo correo. Verifica el estado de la cuenta de Auco y reintenta. Detalle: ${detalle}`,
        'AUCO_UPLOAD_FAILED',
      );
    }
  } else if (row.auco_document_code) {
    // Caso normal (mismo email): pedirle a Auco que reenvie recordatorio.
    // Si falla se dice: antes el toast decía «Recordatorio enviado» sin que saliera nada.
    try {
      await aucoClient.sendReminder(row.auco_document_code);
    } catch (aucoError) {
      logger.error({ error: aucoError, solicitudId }, 'Error al enviar recordatorio via Auco');
      throw new AppError(502, 'AUCO_RECORDATORIO_FALLIDO', 'No se pudo enviar el recordatorio. Intenta de nuevo en unos minutos.');
    }
  }

  // Generate new token
  const newToken = crypto.randomBytes(32).toString('hex');

  // Update — incluye email_firmante nuevo, auco_document_code y plazo nuevos si aplica.
  const updatePayload: Record<string, unknown> = {
    token: newToken,
    estado: 'enviado',
    envios_realizados: row.envios_realizados + 1,
    updated_at: new Date().toISOString(),
  };
  if (cambiaEmail) {
    updatePayload.email_firmante = emailNuevoNormalizado;
    updatePayload.auco_document_code = nuevoAucoDocumentCode;
    if (nuevaExpiracion) updatePayload.token_expiracion = nuevaExpiracion;
  }

  let actualizar = (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .update(updatePayload as never)
    .eq('id', solicitudId);
  // Con documento nuevo, CAS sobre el anterior: si otro reenvío la cambió
  // mientras tanto, el documento que se acaba de subir no queda huérfano y vivo.
  if (cambiaEmail) {
    actualizar = row.auco_document_code
      ? actualizar.eq('auco_document_code', row.auco_document_code)
      : actualizar.is('auco_document_code', null);
  }
  const { data: updated, error: updateError } = await actualizar.select(SOLICITUD_SELECT).maybeSingle();

  if (updateError || !updated) {
    if (cambiaEmail && nuevoAucoDocumentCode) await anularDocumentoHuerfano(nuevoAucoDocumentCode, row.contrato_id);
    if (!updateError && cambiaEmail) {
      throw AppError.conflict('Otro reenvío cambió esta solicitud mientras tanto. Actualiza la página.', 'FIRMA_YA_EN_CURSO');
    }
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
    .select('id, contrato_id, envios_realizados, max_envios, contratos!inner(expediente_id, expedientes!inner(solicitante_id))')
    .eq('id', solicitudId)
    .single();

  if (solError || !solRow) {
    throw AppError.notFound('Solicitud de firma no encontrada', 'SOLICITUD_NOT_FOUND');
  }

  const sol = solRow as unknown as {
    id: string;
    contrato_id: string;
    envios_realizados: number;
    max_envios: number;
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

  // 2.5. El cupo de envíos es uno solo por sobre (y el recordatorio avisa a
  //      todas las partes): el último queda para la inmobiliaria o el
  //      propietario, que si no se quedaban sin su botón de recordatorio.
  if (sol.envios_realizados >= sol.max_envios - 1) {
    throw AppError.badRequest(
      'Ya pediste el reenvío varias veces. Si todavía no te llega, pide a la inmobiliaria o al propietario que te lo reenvíe.',
      'MAX_ENVIOS_SELF',
    );
  }

  // 3. Reusar el flujo principal con el email alternativo opcional. La
  //    pertenencia YA quedó validada arriba por solicitantes.creado_por, así
  //    que pasamos userRol=undefined para que el guard del flujo principal sea
  //    no-op (no doble-gatear al solicitante, cuyo scope no es por expediente).
  return reenviarSolicitudFirma(solicitudId, userId, undefined, ip, emailAlternativo);
}

// ============================================================
// Consultar estado de una solicitud
// ============================================================

export async function getSolicitud(solicitudId: string, userId?: string, userRol?: string) {
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select(`${SOLICITUD_SELECT}, perfiles(id, nombre, apellido), contratos(expediente_id)`)
    .eq('id', solicitudId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Solicitud de firma no encontrada', 'SOLICITUD_NOT_FOUND');
  }

  const row = data as unknown as SolicitudFirmaRow & {
    perfiles: { id: string; nombre: string; apellido: string } | null;
    contratos: { expediente_id: string | null } | null;
  };

  // Guard de pertenencia (IDOR): no-op para roles internos / sin identidad;
  // 404 fuera de scope (no confirma existencia cross-tenant).
  await assertExpedienteAccess(row.contratos?.expediente_id ?? '', userId, userRol);

  return {
    ...row,
    enviado_por_nombre: row.perfiles
      ? `${row.perfiles.nombre} ${row.perfiles.apellido}`
      : null,
    token: undefined, // Don't expose token
    perfiles: undefined,
    contratos: undefined,
  };
}

// ============================================================
// Listar solicitudes de un contrato
// ============================================================

export async function listarSolicitudes(contratoId: string, userId?: string, userRol?: string) {
  // Verify contrato exists
  const { data: contrato } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id')
    .eq('id', contratoId)
    .single();

  if (!contrato) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  // Guard de pertenencia (IDOR): no-op para roles internos / sin identidad;
  // 404 si el contrato no está en el scope del usuario.
  await assertExpedienteAccess(
    (contrato as { expediente_id?: string | null }).expediente_id ?? '',
    userId,
    userRol,
  );

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

/**
 * Anula el sobre en Auco. Auco exige `message` y `email` (usuario de la
 * organización) y puede responder 200 sin haber cancelado (`errors.cant`), así
 * que eso también se registra como error. Lanza solo si la llamada falla.
 */
async function cancelarSobreEnAuco(code: string): Promise<void> {
  const r = await aucoClient.cancelDocument(code, {
    message: 'Contrato cancelado en Cofianza',
    email: env.AUCO_SENDER_EMAIL,
  });
  if (r?.success === false || (r?.errors?.cant ?? 0) > 0) {
    logger.error({ code, respuesta: r }, 'Auco no canceló el documento');
  }
}

/**
 * Cancela TODAS las solicitudes de firma no terminales de un contrato (y sus
 * sobres en Auco). Pensada para los side-effects de "Cancelar contrato": si el
 * contrato estaba en pendiente_firma, sin esto los firmantes conservaban el
 * link de Auco activo y podían firmar (y recibir acuse de) un contrato ya
 * cancelado. LOG-ONLY: nunca lanza — la transición del contrato ya quedó
 * confirmada en BD y no debe revertirse por un fallo aquí. También marca
 * cancelados los contrato_firmantes no terminales (flujo multi-parte).
 */
export async function cancelarSolicitudesDeContrato(contratoId: string): Promise<void> {
  try {
    const { data } = await (supabase
      .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado, auco_document_code')
      .eq('contrato_id', contratoId)
      .not('estado', 'in', '("firmado","cancelado","expirado")');
    const rows = (data as unknown as Array<{ id: string; estado: string; auco_document_code: string | null }>) ?? [];

    for (const row of rows) {
      if (row.auco_document_code) {
        try {
          await cancelarSobreEnAuco(row.auco_document_code);
        } catch (aucoError) {
          logger.error(
            { error: aucoError, solicitudId: row.id, contratoId },
            'No se pudo cancelar el documento en Auco al cancelar el contrato',
          );
        }
      }
      const { error: updError } = await (supabase
        .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
        .update({ estado: 'cancelado', updated_at: new Date().toISOString() } as never)
        .eq('id', row.id);
      if (updError) {
        logger.error({ error: updError.message, solicitudId: row.id }, 'No se pudo marcar cancelada la solicitud de firma');
      }
    }

    // Multi-parte: los firmantes pendientes también quedan cancelados para que
    // el panel de firmantes no siga mostrando "esperando firma".
    const { error: firmantesErr } = await (supabase
      .from('contrato_firmantes' as string) as ReturnType<typeof supabase.from>)
      .update({ estado: 'cancelado', updated_at: new Date().toISOString() } as never)
      .eq('contrato_id', contratoId)
      .not('estado', 'in', '("firmado","cancelado","expirado")');
    if (firmantesErr) {
      logger.warn({ error: firmantesErr.message, contratoId }, 'No se pudieron cancelar los contrato_firmantes pendientes');
    }

    if (rows.length > 0) {
      logger.info({ contratoId, solicitudes: rows.length }, 'Solicitudes de firma canceladas al cancelar el contrato');
    }
  } catch (err) {
    logger.error({ err, contratoId }, 'Error cancelando solicitudes de firma del contrato');
  }
}

/**
 * Anula en Auco un documento recién subido cuyo registro no se completó (p. ej.
 * doble clic contra el índice de un solo sobre activo): si no, quedaría un
 * documento vivo que nadie ve. Mejor esfuerzo: si Auco no lo anula, al log.
 */
export async function anularDocumentoHuerfano(code: string, contratoId: string): Promise<void> {
  try {
    const r = await aucoClient.cancelDocument(code, { message: 'Envío a firma no registrado en Cofianza', email: env.AUCO_SENDER_EMAIL });
    if (r?.success === false || (r?.errors?.cant ?? 0) > 0) {
      logger.error({ contratoId, code, respuesta: r }, 'Auco no anuló el documento que no quedó registrado');
    }
  } catch (err) {
    logger.error({ contratoId, code, error: err instanceof Error ? err.message : String(err) }, 'No se pudo anular en Auco el documento que no quedó registrado');
  }
}

// ============================================================
// Reenvío a firma: cerrar el envío anterior sin perder una firma
// ============================================================

const auco503 = () =>
  new AppError(503, 'AUCO_NO_VERIFICABLE', 'No pudimos confirmar en Auco qué pasó con el envío anterior. Intenta de nuevo en unos minutos.');

/**
 * Cómo se lee una firma completa según quién pregunta. `mensaje`: el del 409.
 * `siAucoNoResponde`: 'seguir' para una cancelación manual (no se frena por
 * Auco caído; queda en el log); por defecto, 503.
 */
interface OpcionesFirmaCompleta {
  mensaje?: string;
  siAucoNoResponde?: 'error' | 'seguir';
}

/** Todas las partes ya firmaron: el contrato se lleva a firmado (y vigente) y 409. */
async function yaFirmado(contratoId: string, expedienteId: string, mensaje?: string): Promise<never> {
  const { maybeAutoTransicionarFirmado, maybeAutoActivarVigente } = await import('@/modules/contratos/contratos.service');
  await maybeAutoTransicionarFirmado(contratoId);
  await maybeAutoActivarVigente(contratoId, expedienteId);
  throw AppError.conflict(
    mensaje ?? 'Este contrato ya estaba firmado: todas las partes firmaron el envío anterior. Actualiza la página.',
    'CONTRATO_YA_FIRMADO',
  );
}

/**
 * Lo que dice Auco del documento de un envío, solo lectura. Si ya lo firmaron
 * todos y el aviso se perdió, se concilia por el camino del webhook y 409
 * CONTRATO_YA_FIRMADO. Si Auco no lo conoce (404: creado en stage o en otra
 * cuenta), null: no hay nada vivo que cerrar. Si Auco no responde, 503 (o
 * null con 'seguir').
 */
async function leerDocumentoEnAuco(
  contratoId: string,
  expedienteId: string,
  code: string,
  opts: OpcionesFirmaCompleta = {},
): Promise<aucoClient.AucoDocumentInfo | null> {
  const info = await aucoClient.getDocumentStatus(code).catch((err: unknown) => {
    const detalle = err instanceof Error ? err.message : String(err);
    if (detalle.startsWith('Auco API error (404)')) {
      logger.warn({ contratoId, code, error: detalle }, 'Firma: Auco no conoce el documento (stage u otra cuenta); se toma como cerrado');
      return null;
    }
    logger.error({ contratoId, code, error: detalle }, 'Firma: no se pudo consultar en Auco el documento de un envío');
    if (opts.siAucoNoResponde === 'seguir') return null;
    throw auco503();
  });
  if (info?.status === 'FINISH') {
    // Con la hora real de la última firma (roadmap, como el V3); si no la da, la de ahora.
    const roadmap = await aucoClient.getDocumentRoadmap(code).catch(() => null);
    const { ultimaFirma } = await import('@/modules/contratos/v3/firma/reglas');
    await handleAucoWebhook({ code, name: info.name ?? '', status: 'FINISH', url: info.url }, ultimaFirma(roadmap, 1) ?? undefined);
    await yaFirmado(contratoId, expedienteId, opts.mensaje);
  }
  return info;
}

/**
 * El documento de Auco de un envío anterior, antes de abrir otro (contratos-
 * firma-2). Si ya lo firmaron todos, 409 (leerDocumentoEnAuco). Si sigue vivo,
 * se anula; si Auco no lo anula, se relee (como cancelarEnAuco del V3):
 * vencido o rechazado ya está cerrado. Si no se puede leer o sigue vivo, 503:
 * ni un firmado dado por cancelado ni dos documentos vivos. Devuelve su estado local.
 */
async function cerrarDocumentoAnterior(contratoId: string, expedienteId: string, code: string): Promise<'expirado' | 'cancelado'> {
  const cerrado = (status: string) => (status === 'EXPIRED' ? 'expirado' : status === 'REJECTED' ? 'cancelado' : null);

  const info = await leerDocumentoEnAuco(contratoId, expedienteId, code);
  const antes = info ? cerrado(info.status) : 'cancelado';
  if (antes) return antes;

  const anulado = await aucoClient
    .cancelDocument(code, { message: 'Reenviado a firma en Cofianza', email: env.AUCO_SENDER_EMAIL })
    .then((r) => r?.success !== false && !((r?.errors?.cant ?? 0) > 0))
    .catch(() => false);
  if (anulado) return 'cancelado';
  const despues = await leerDocumentoEnAuco(contratoId, expedienteId, code);
  const ya = despues ? cerrado(despues.status) : 'cancelado';
  if (ya) return ya;
  logger.error({ contratoId, code, status: despues?.status }, 'Reenvío a firma: Auco no anuló el documento anterior');
  throw auco503();
}

/** Los envíos del contrato que no están cerrados. Si alguno ya quedó firmado (el contrato no llegó a pasar), 409. */
async function sobresSinCerrar(contratoId: string, expedienteId: string, mensaje?: string) {
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, auco_document_code')
    .eq('contrato_id', contratoId)
    .not('estado', 'in', '("cancelado","expirado")');
  if (error) {
    throw new AppError(503, 'LECTURA_NO_VERIFICABLE', 'No pudimos verificar el envío a firma anterior. Intenta de nuevo en un momento.');
  }
  const sobres = (data as Array<{ id: string; estado: string; auco_document_code: string | null }> | null) ?? [];
  if (sobres.some((s) => s.estado === 'firmado')) await yaFirmado(contratoId, expedienteId, mensaje);
  return sobres;
}

/**
 * Si algún envío del contrato ya quedó firmado, o Auco lo dice (el aviso se
 * perdió), se concilia y 409, como exigirSinFirmaCompleta del V3. Solo lee. Va
 * antes de las guardas del envío a firma (P6, P21, datos, firmantes, CRC), que
 * con otro error la taparían, y antes de cancelar el contrato, un envío suyo o
 * un contrato hermano (superseder).
 */
export async function exigirSinFirmaCompleta(contratoId: string, expedienteId: string, opts: OpcionesFirmaCompleta = {}): Promise<void> {
  for (const s of await sobresSinCerrar(contratoId, expedienteId, opts.mensaje)) {
    if (s.auco_document_code) await leerDocumentoEnAuco(contratoId, expedienteId, s.auco_document_code, opts);
  }
}

/** El 409 de las cancelaciones manuales (contrato o envío) cuando todas las partes ya firmaron. */
export const YA_FIRMADO_NO_SE_CANCELA = 'Todas las partes ya firmaron este contrato: quedó firmado y no se puede cancelar. Actualiza la página.';

/**
 * Antes de abrir un sobre nuevo (reenvío a firma): cada envío anterior sin
 * terminar se cierra con cerrarDocumentoAnterior y solo después se marca. Los
 * firmantes no se tocan: el sobre nuevo los reemplaza, y en «cancelado» se
 * leerían como un rechazo. «Cancelar contrato» sigue con
 * cancelarSolicitudesDeContrato.
 */
export async function anularSobresAnteriores(contratoId: string, expedienteId: string): Promise<void> {
  for (const s of await sobresSinCerrar(contratoId, expedienteId)) {
    const estado = s.auco_document_code ? await cerrarDocumentoAnterior(contratoId, expedienteId, s.auco_document_code) : 'cancelado';
    const { error: updError } = await (supabase
      .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
      .update({ estado, updated_at: new Date().toISOString() } as never)
      .eq('id', s.id);
    if (updError) {
      logger.error({ contratoId, solicitudId: s.id, error: updError.message }, 'Reenvío a firma: no se pudo cerrar el envío anterior');
      throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo cerrar el envío a firma anterior. Intenta de nuevo.');
    }
  }
}

export async function cancelarSolicitud(
  solicitudId: string,
  userId: string,
  userRol?: string,
  ip?: string,
) {
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, estado, auco_document_code, contratos(expediente_id)')
    .eq('id', solicitudId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Solicitud no encontrada', 'SOLICITUD_NOT_FOUND');
  }

  const row = data as unknown as {
    id: string; contrato_id: string; estado: string; auco_document_code: string | null;
    contratos: { expediente_id: string | null } | null;
  };

  // Guard de pertenencia (IDOR): no-op para roles internos / sin identidad;
  // 404 fuera de scope. Se aplica ANTES de cancelar el sobre en Auco / mutar.
  await assertExpedienteAccess(row.contratos?.expediente_id ?? '', userId, userRol);

  if (['firmado', 'cancelado'].includes(row.estado)) {
    throw AppError.badRequest('No se puede cancelar esta solicitud', 'INVALID_STATE');
  }

  // Cancel in Auco if document code exists. Antes, si todas las partes ya
  // firmaron (el aviso se perdió), se concilia y 409; si Auco no responde, sigue.
  if (row.auco_document_code) {
    await leerDocumentoEnAuco(row.contrato_id, row.contratos?.expediente_id ?? '', row.auco_document_code, {
      mensaje: YA_FIRMADO_NO_SE_CANCELA,
      siAucoNoResponde: 'seguir',
    });
    try {
      await cancelarSobreEnAuco(row.auco_document_code);
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
// Auco Webhook Handler
// ============================================================

/**
 * Process incoming webhook notifications from Auco.
 * Maps Auco statuses to our internal solicitud states:
 *   NOTIFICATION → abierto (signer was notified / opened)
 *   FINISH       → firmado (all signers completed)
 *   REJECTED     → cancelado (signer rejected)
 *   BLOCKED      → sin cambio: sigue en firma y se avisa a Cofianza para desbloquear
 *   EXPIRED      → expirado (past deadline)
 * `firmadoEn`: la hora real de la firma cuando se concilia leyendo Auco (el webhook no la trae).
 */
export async function handleAucoWebhook(payload: AucoWebhookPayload, firmadoEn?: string) {
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

  // Un sobre que Cofianza ya canceló (o que venció) no se toca: si Auco siguió
  // vivo y alguien firmó, el evento no puede volver 'firmado' al firmante ni al
  // sobre de un contrato cancelado.
  if (['cancelado', 'expirado'].includes(row.estado)) {
    logger.info({ id: row.id, estado: row.estado, aucoStatus: status }, 'Auco webhook: sobre cancelado o vencido, evento ignorado');
    return;
  }

  // Multi-parte (M1): si ESTE sobre tiene firmantes registrados (no otro del
  // mismo contrato), el estado por parte vive en contrato_firmantes.
  // Actualizamos DIRECTO desde el PAYLOAD del webhook (signer + status) — NO
  // por poll a getDocumentStatus, que en stage devuelve 401 y dejaba el panel
  // congelado en "0/3". NOTIFICATION(+signer) = ese firmante firmó; FINISH =
  // todas firmaron.
  const { data: cfRows } = await (supabase
    .from('contrato_firmantes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('contrato_id', row.contrato_id)
    .eq('solicitud_firma_id', row.id)
    .limit(1);
  if (cfRows && (cfRows as unknown[]).length > 0) {
    const { reconciliarFirmantesPorWebhook } = await import('./firma-multiparte.service');
    await reconciliarFirmantesPorWebhook(
      row.contrato_id,
      { id: row.id, estado: row.estado },
      payload,
      firmadoEn,
    ).catch((err) =>
      logger.error({ error: err, contratoId: row.contrato_id }, 'Auco webhook: error reconciliando multi-parte (payload)'),
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
      updateFields.firmado_en = firmadoEn ?? now;
      if (signedUrl) {
        updateFields.auco_signed_url = signedUrl;
      }
      break;

    case 'REJECTED':
    case 'REJECT':
      newEstado = 'cancelado';
      break;

    case 'BLOCKED': {
      // No es final (como en el V3): sigue en firma y Cofianza desbloquea en Auco.
      const { avisarFirmanteBloqueado } = await import('./firma-multiparte.service');
      await avisarFirmanteBloqueado(row.contrato_id, code);
      return;
    }

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
 * documento esta FINISH, actualiza la solicitud_firma local (el contrato lo
 * mueve el auto-heal al listar contratos).
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

  let sol = solRow as unknown as {
    id: string;
    auco_signed_url: string | null;
    auco_document_code: string;
  } | null;

  // 2b. RESCATE: sin auco_signed_url guardada (webhooks/polls viejos no la
  //     persistían, o expiró antes de usarse) pero con document code, pedirle
  //     a Auco una URL fresca. Auco conserva el documento firmado: mientras
  //     el sobre exista, esta vía recupera el PDF con las firmas estampadas.
  if (!sol?.auco_signed_url) {
    const { data: solCodeRow } = await (supabase
      .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
      .select('id, auco_document_code')
      .eq('contrato_id', contratoId)
      .eq('estado', 'firmado')
      .not('auco_document_code', 'is', null)
      .order('firmado_en', { ascending: false })
      .limit(1)
      .maybeSingle();
    let solCode = solCodeRow as unknown as { id: string; auco_document_code: string } | null;
    // Respaldo V3 (Entrega 5): el asistente no usa solicitudes_firma; el código
    // de Auco está en su sobre completo. No hay fila de solicitud que persistir.
    let esSobreV3 = false;
    if (!solCode) {
      const { data: sobreRow } = await (supabase
        .from('contrato_v3_sobres' as string) as ReturnType<typeof supabase.from>)
        .select('id, auco_code')
        .eq('contrato_id', contratoId)
        .eq('estado', 'completo')
        .not('auco_code', 'is', null)
        .order('intento', { ascending: false })
        .limit(1)
        .maybeSingle();
      const sobre = sobreRow as { id: string; auco_code: string } | null;
      if (sobre) {
        solCode = { id: sobre.id, auco_document_code: sobre.auco_code };
        esSobreV3 = true;
      }
    }
    if (solCode?.auco_document_code) {
      try {
        const info = await aucoClient.getDocumentStatus(solCode.auco_document_code);
        if (info.status === 'FINISH' && info.url) {
          sol = { id: solCode.id, auco_signed_url: info.url, auco_document_code: solCode.auco_document_code };
          // Persistir la URL para diagnósticos futuros (no crítica: expira).
          if (!esSobreV3) {
            await (supabase
              .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
              .update({ auco_signed_url: info.url, updated_at: new Date().toISOString() } as never)
              .eq('id', solCode.id);
          }
          logger.info({ contratoId, aucoCode: solCode.auco_document_code }, 'archivarPdfFirmado: URL recuperada de Auco por document code');
        }
      } catch (err) {
        logger.warn(
          { contratoId, error: err instanceof Error ? err.message : String(err) },
          'archivarPdfFirmado: no se pudo recuperar la URL desde Auco por document code',
        );
      }
    }
  }

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
