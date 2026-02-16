import { supabase } from '@/lib/supabase';
import { env } from '@/config/env';

interface HealthStatus {
  status: 'ok' | 'degraded';
  timestamp: string;
  version: string;
  environment: string;
  database: 'connected' | 'disconnected';
}

export async function getHealthStatus(): Promise<HealthStatus> {
  let database: 'connected' | 'disconnected' = 'disconnected';

  try {
    const { error } = await supabase.from('_health_check').select('*').limit(0);
    // Any response from PostgREST (even table-not-found 42P01) means DB is reachable
    if (!error || error.code === '42P01') {
      database = 'connected';
    }
  } catch {
    database = 'disconnected';
  }

  return {
    status: database === 'connected' ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '1.0.0',
    environment: env.NODE_ENV,
    database,
  };
}
