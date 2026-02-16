import dotenv from 'dotenv';
import { existsSync } from 'fs';

// Cargar .env.local si existe, sino .env como fallback
const envFile = existsSync('.env.local') ? '.env.local' : '.env';
dotenv.config({ path: envFile });

export { env } from './env';
