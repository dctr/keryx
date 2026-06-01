import { createServer } from './app';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.PORT ?? '4173', 10);

if (Number.isNaN(port)) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const server = createServer();

try {
  await server.listen({ host, port });
  console.log(`Keryx server listening on http://${host}:${port}`);
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
