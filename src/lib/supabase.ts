import { createClient } from '@supabase/supabase-js';
import { Agent, fetch as undiciFetch } from 'undici';
import { env } from '@/config/env';
import type { Database } from '@/types/database.types';

/**
 * Conexiones a Supabase que se reutilizan (perf). El fetch de Node cierra una
 * conexión a los 4 s sin uso, y con el tráfico de hoy casi cada consulta abría
 * una nueva: medido, la misma consulta tarda ~200 ms por una conexión abierta y
 * ~500 ms por una nueva (la API está en Ámsterdam y Supabase en Oregón). Aquí
 * quedan vivas 60 s. Solo lo usan los clientes de Supabase; los cuerpos que se
 * envían son strings y Buffers (nunca FormData del fetch global).
 */
const conexiones = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 300_000 });
export const fetchSupabase = ((input: string | URL, init?: RequestInit) =>
  undiciFetch(input, { ...(init as object), dispatcher: conexiones })) as unknown as typeof fetch;

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
  global: { fetch: fetchSupabase },
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
  global: { fetch: fetchSupabase },
});
