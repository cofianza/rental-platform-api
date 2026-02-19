import { createClient } from '@supabase/supabase-js';
import { env } from '@/config/env';
import type { Database } from '@/types/database.types';

/**
 * Cliente para operaciones de autenticacion (signIn, getUser, etc.).
 * NO usar para queries de datos (.from()) ya que signInWithPassword
 * contamina la sesion interna y los queries usan el JWT del usuario
 * en vez de la service_role key, causando que tablas con RLS sin
 * policies devuelvan 0 filas.
 */
export const supabaseAuth = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Cliente para queries de datos (.from(), .rpc()).
 * Siempre usa service_role key → bypassa RLS.
 * NUNCA llamar .auth.signInWithPassword() ni .auth.getUser() en este cliente.
 */
export const supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
