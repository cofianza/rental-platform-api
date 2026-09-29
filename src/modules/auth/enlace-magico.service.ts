/**
 * Enlace mágico para el arrendatario invitado a un estudio (decisión H44,
 * 2026-09-28): entra con un enlace a su correo en vez de crear contraseña.
 *
 * - Supabase genera el enlace (admin.generateLink, no manda correo) y lo
 *   enviamos con nuestra plantilla (Resend).
 * - El enlace lleva a /auth/confirmar de la web, que solo lo usa cuando la
 *   persona toca «Entrar» (los antivirus de correo abren los enlaces). El
 *   token_hash va en el fragmento (#), que el navegador no manda a ningún
 *   servidor, y se canjea aquí por POST (verifyOtp). Vence según la
 *   configuración de Supabase (se recomienda 1 hora) y es de un solo uso.
 * - Solo a correos invitados a un estudio (expedientes.email_invitacion, lo
 *   envíe un propietario o una inmobiliaria). A cualquier otro correo, a una
 *   cuenta de otro rol o inactiva, la respuesta es la misma genérica y no se
 *   genera nada: no se revela si el correo tiene cuenta ni de qué tipo.
 * - Si el invitado aún no tiene cuenta y manda sus datos, se le crea sin
 *   contraseña y como arrendatario (rol 'solicitante': el mismo alta del
 *   registro de la vitrina). Nunca se le cambia el rol a una cuenta existente.
 * - El token nunca va a los logs.
 */
import { supabase, supabaseAuth } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { sendEnlaceMagicoEmail } from '@/lib/email';
import { crearCuentaSolicitante } from '../vitrina/vitrina.service';
import type { EnlaceMagicoInput, VerificarEnlaceMagicoInput } from './auth.schema';

const db = (table: string) => supabase.from(table as string) as ReturnType<typeof supabase.from>;

export const MENSAJE_ENLACE_GENERICO =
  'Si su correo tiene una invitación a un estudio, le enviamos un enlace para entrar. Revise su bandeja de entrada (y la carpeta de spam).';

/** `%`, `_` y `\` son comodines de ILIKE: sin escaparlos, «a_b@x.co» casaría «axb@x.co». */
const literalIlike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Invitaciones a estudios (no canceladas) enviadas a ese correo. */
async function invitacionesDe(email: string): Promise<Array<{ solicitante_id: string | null }> | null> {
  const { data, error } = await db('expedientes')
    .select('solicitante_id')
    .ilike('email_invitacion', literalIlike(email))
    .not('token_invitacion', 'is', null)
    .is('cancelado_at', null)
    .limit(20);
  if (error) {
    logger.error({ error: error.message }, 'Enlace mágico: no se pudieron leer las invitaciones');
    return null;
  }
  return (data as Array<{ solicitante_id: string | null }> | null) ?? [];
}

/**
 * POST /auth/enlace-magico. Siempre resuelve con el mismo mensaje (salvo un
 * 400 de validación): quien pregunta no sabe si el correo existe.
 */
export async function solicitarEnlaceMagico(input: EnlaceMagicoInput, ip?: string, userAgent = ''): Promise<void> {
  const email = input.email.trim().toLowerCase();

  const invitaciones = await invitacionesDe(email);
  if (!invitaciones || invitaciones.length === 0) {
    logger.info({ email }, 'Enlace mágico pedido para un correo sin invitación');
    return;
  }

  const { data: cuenta, error: rpcError } = await supabase
    .rpc('find_user_by_email' as never, { user_email: email } as never)
    .maybeSingle<{ id: string }>();
  if (rpcError) {
    logger.error({ error: rpcError.message }, 'Enlace mágico: no se pudo buscar la cuenta');
    return;
  }

  let userId: string;
  if (cuenta) {
    const { data: perfil } = await db('perfiles').select('rol, estado').eq('id', cuenta.id).maybeSingle();
    const p = perfil as { rol: string; estado: string } | null;
    if (p?.rol !== 'solicitante' || p.estado !== 'activo') {
      // Invitado con una cuenta de propietario, inmobiliaria o de Cofianza (o
      // desactivada): no se le abre sesión por aquí ni se le toca el rol.
      logger.warn({ userId: cuenta.id, rol: p?.rol, estado: p?.estado }, 'Enlace mágico negado: la cuenta no es de arrendatario activa');
      return;
    }
    userId = cuenta.id;
  } else {
    // Sin cuenta: solo se crea con una invitación pendiente y los datos del alta.
    const pendiente = invitaciones.some((i) => !i.solicitante_id);
    if (!pendiente || !input.datos) {
      logger.info({ email, pendiente }, 'Enlace mágico sin cuenta: faltan datos o no hay invitación pendiente');
      return;
    }
    try {
      userId = await crearCuentaSolicitante(
        { ...input.datos, email, from_invitation: true },
        ip ?? '',
        userAgent,
      );
    } catch (err) {
      // Documento repetido, carrera con otro alta…: la respuesta sigue siendo la genérica.
      logger.warn({ email, errorCode: (err as AppError).errorCode }, 'Enlace mágico: no se pudo crear la cuenta');
      return;
    }
    logger.info({ userId, email, rol: 'solicitante' }, 'Cuenta de arrendatario creada sin contraseña (enlace mágico)');
  }

  const { data: link, error: linkError } = await supabaseAuth.auth.admin.generateLink({ type: 'magiclink', email });
  const hashed = link?.properties?.hashed_token;
  if (linkError || !hashed) {
    logger.error({ userId, error: linkError?.message }, 'Enlace mágico: Supabase no generó el enlace');
    return;
  }

  try {
    await sendEnlaceMagicoEmail(email, `${env.FRONTEND_URL}/auth/confirmar#token_hash=${encodeURIComponent(hashed)}`);
  } catch {
    return; // sendEnlaceMagicoEmail ya lo registró (sin el enlace)
  }
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ENLACE_MAGICO_ENVIADO,
    entidad: AUDIT_ENTITIES.SESSION,
    detalle: { email },
    ip,
  });
}

/** POST /auth/enlace-magico/verificar: canjea el token_hash por la sesión, como el login. */
export async function verificarEnlaceMagico({ token_hash }: VerificarEnlaceMagicoInput, ip?: string) {
  const { data, error } = await supabaseAuth.auth.verifyOtp({ token_hash, type: 'magiclink' });
  if (error || !data.session || !data.user) {
    logger.warn({ error: error?.message }, 'Enlace mágico inválido o vencido');
    throw AppError.unauthorized(
      'Este enlace ya se usó o venció. Pida uno nuevo desde su invitación.',
      'ENLACE_INVALIDO',
    );
  }

  const { data: perfil } = await db('perfiles').select('estado, rol').eq('id', data.user.id).maybeSingle();
  const p = perfil as { estado: string; rol: string } | null;
  if (!p || p.estado !== 'activo') {
    await supabaseAuth.auth.admin.signOut(data.session.access_token);
    throw AppError.forbidden('Cuenta desactivada', 'ACCOUNT_INACTIVE');
  }

  logAudit({
    usuarioId: data.user.id,
    accion: AUDIT_ACTIONS.LOGIN_SUCCESS,
    entidad: AUDIT_ENTITIES.SESSION,
    detalle: { email: data.user.email, rol: p.rol, metodo: 'enlace_magico' },
    ip,
  });
  logger.info({ userId: data.user.id, rol: p.rol }, 'Ingreso con enlace mágico');

  // Si el correo se abrió en otro dispositivo, la web no tiene el token de la
  // invitación: se le devuelve a su dueño (ya probó que el correo es suyo).
  const { data: pendiente } = await db('expedientes')
    .select('token_invitacion')
    .ilike('email_invitacion', literalIlike((data.user.email ?? '').toLowerCase()))
    .is('solicitante_id', null)
    .is('cancelado_at', null)
    .not('token_invitacion', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const tokenInv = (pendiente as { token_invitacion: string } | null)?.token_invitacion;

  return {
    redirect: tokenInv ? `/invitacion/${tokenInv}` : '/dashboard',
    user: { id: data.user.id, email: data.user.email, rol: p.rol },
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    },
  };
}
