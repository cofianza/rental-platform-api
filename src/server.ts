import app from '@/app';
import { env } from '@/config';
import { logger } from '@/lib/logger';

app.listen(env.PORT, () => {
  logger.info(`Server running in ${env.NODE_ENV} mode on http://localhost:${env.PORT}`);
});
