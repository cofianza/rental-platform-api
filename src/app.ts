import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import { env } from '@/config';
import { logger } from '@/lib/logger';
import { errorHandler } from '@/middleware/errorHandler';
import healthRouter from '@/modules/health/health.routes';
import authRouter from '@/modules/auth/auth.routes';

const app = express();

// Security
app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGIN,
  }),
);

// Rate limiting general: 100 req/min por IP
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }),
);

// Rate limiting estricto para auth: 10 req/min por IP
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, errorCode: 'TOO_MANY_REQUESTS', message: 'Demasiados intentos. Intente de nuevo mas tarde.' },
});

// Logging
app.use(pinoHttp({ logger }));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (_req, res) => {
  res.json({ message: 'Habitar Propiedades API v1' });
});
app.use('/api/v1/health', healthRouter);
app.use('/api/v1/auth', authLimiter, authRouter);

// Error handler (must be last)
app.use(errorHandler);

export default app;
