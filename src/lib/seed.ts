import '@/config';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';

async function seed() {
  logger.info('Seeding database...');

  // Verify Supabase connection
  const { error } = await supabase.from('_seed_check').select('*').limit(0);
  if (error && !error.message.includes('does not exist')) {
    throw error;
  }

  // TODO: Add seed data here

  logger.info('Seeding complete');
}

seed().catch((err) => {
  logger.error({ err }, 'Seed failed');
  process.exit(1);
});
