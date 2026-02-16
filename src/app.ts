import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from '@/config';
import { logger } from '@/lib/logger';
import { errorHandler } from '@/middleware/errorHandler';
import { generalLimiter, authLimiter } from '@/middleware/rateLimiter';
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

// Rate limiting
app.use(generalLimiter);

// Logging with request ID tracing
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => {
      const existing = req.headers['x-request-id'];
      return typeof existing === 'string' ? existing : crypto.randomUUID();
    },
  }),
);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/v1/health', healthRouter);
app.use('/api/v1/auth', authLimiter, authRouter);

// Error handler (must be last)
app.use(errorHandler);

export default app;
