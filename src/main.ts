import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: §8.1 webhook HMAC is computed over the raw request body.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  // §5.7 control 2: TLS 1.2+ is terminated at the platform edge in front of this
  // process; plaintext HTTP is refused there, not redirected. That edge is also
  // the only thing allowed to set X-Forwarded-For, so exactly one hop is
  // trusted — without this, req.ip is the proxy and every session bind and
  // audit row records the wrong client address.
  app.set('trust proxy', 1);
  // §9.22 merchant console: three static files served under /app by this same
  // process, so a release is one artifact and the host runs no frontend build.
  // Mounted on a prefix (not '/') so it cannot shadow the API routes or the
  // OAuth landing surface at '/'. The console routes on the hash, so there is
  // no client-side path to 404 and no catch-all is needed.
  app.useStaticAssets(join(__dirname, 'ui', 'public'), { prefix: '/app' });
  // Drain in-flight requests and close pool/queue connections on SIGTERM so a
  // systemd restart is not a mid-request kill.
  app.enableShutdownHooks();
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  // Behind the edge proxy the process binds loopback only (HOST=127.0.0.1);
  // the default keeps local dev reachable.
  await app.listen(port, process.env.HOST ?? '0.0.0.0');
}

void bootstrap();
