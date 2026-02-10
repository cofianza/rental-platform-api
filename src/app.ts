import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import healthRouter from './routes/health';
import { errorHandler } from './middleware/errorHandler';

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (_req, res) => {
  res.json({ message: 'Habitar Propiedades API v1' });
});
app.use('/health', healthRouter);

// Error handler (must be last)
app.use(errorHandler);

export default app;
