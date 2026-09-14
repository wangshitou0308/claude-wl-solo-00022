import { buildApp } from './app.js';
import { initDb } from './db.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

await initDb();
const app = buildApp();

app
  .listen({ port, host })
  .then((address) => {
    app.log.info(`sewfit-api 已启动: ${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
