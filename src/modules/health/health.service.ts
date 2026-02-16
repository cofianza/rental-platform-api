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
    // supabase-js never throws on API errors — it returns { data, error }.
    // Getting any response (even an error like "table not found") proves connectivity.
    // Only a network failure (fetch throws) means truly disconnected.
    const { error } = await supabase.from('_health_check').select('count', { count: 'exact', head: true });
    // If error exists but we got a response, connection is still alive
    if (!error || error.code) {
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
