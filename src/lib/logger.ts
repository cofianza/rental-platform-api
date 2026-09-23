import pino from 'pino';
import { env } from '@/config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }),
});

// Los enlaces públicos llevan en la ruta un token de 64 hex (autorizar, cargar
// documentos, visita, reset de contraseña…): sin esto pino-http los deja enteros
// en los logs y quien los lea puede usarlos mientras sigan vigentes.
export const httpLogSerializers = {
  req: (req: { url?: unknown }) => {
    if (typeof req.url === 'string') req.url = req.url.replace(/[a-f0-9]{64,}/gi, '***');
    return req;
  },
};
