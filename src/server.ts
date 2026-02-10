import app from './app';
import { config } from './config';

app.listen(config.port, () => {
  console.log(`[server] Running in ${config.env} mode on http://localhost:${config.port}`);
});
