import 'reflect-metadata';

import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { AppConfig } from './config/config';
import { Logger } from './observability/logger';

/**
 * The API entrypoint.
 *
 * Fastify rather than Express (ADR-0019). Note `bodyLimit`: this service is a
 * control plane and the largest thing it should ever be asked to parse is a run
 * manifest. Bytes go directly to object storage over presigned URLs and never
 * reach this process, so a generous body limit would not enable a legitimate
 * use -- it would only widen the window for an expensive one.
 */
async function bootstrap(): Promise<void> {
  const config = new AppConfig(process.env);
  const logger = new Logger({
    level: config.logLevel,
    base: { service: 'aliquot', role: 'api' },
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // 2 MiB. A manifest of ten thousand artifacts is comfortably under this.
      bodyLimit: 2 * 1024 * 1024,
      // The correlation middleware assigns its own; Fastify's would be a second
      // identifier meaning almost the same thing, which is worse than none.
      genReqId: () => '',
      trustProxy: true,
    }),
    { logger, bufferLogs: false },
  );

  // Nest's shutdown hooks close the injector, which closes the database pool.
  // Without this, a SIGTERM during a rolling deploy kills in-flight transactions
  // rather than letting them commit.
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Aliquot')
      .setDescription(
        'Instrument run ingestion and provenance service.\n\n' +
          'Errors are RFC 9457 problem details (`application/problem+json`). ' +
          'Collections use opaque cursor pagination -- offset pagination over an ' +
          'append-only log skips and repeats rows under concurrent inserts. ' +
          'Mutating endpoints marked `Idempotency-Key` require that header and ' +
          'replay the original response for a repeated key with an identical body.',
      )
      .setVersion('1.0.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          description:
            'A user session token, or an instrument API key beginning `aliq_`. ' +
            'Instruments are first-class principals, not users with a shared login.',
        },
        'bearer',
      )
      .addTag('runs', 'Registration, sealing, correction and search')
      .addTag('uploads', 'Resumable, integrity-verified artifact transfer')
      .addTag('artifacts', 'Content-addressed artifacts and their lineage')
      .addTag('audit', 'The append-only hash chain and its verification')
      .addTag('identity', 'Studies, members and instrument credentials')
      .addTag('health', 'Liveness and readiness')
      .build(),
  );

  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'openapi.json',
    yamlDocumentUrl: 'openapi.yaml',
    swaggerOptions: { persistAuthorization: true },
  });

  // The read-only viewer. Served from the API process rather than a separate
  // container because it is three static files with no build step (ADR-0018),
  // and a second service in compose would cost a reviewer more than it returns.
  await app.register(import('@fastify/static'), {
    root: join(__dirname, 'viewer', 'public'),
    prefix: '/',
    decorateReply: false,
  });

  // 0.0.0.0, not the default localhost: inside a container, binding the loopback
  // makes the service unreachable from everywhere including its own health
  // check, and the symptom is a container that looks healthy and refuses
  // connections.
  await app.listen({ port: config.port, host: '0.0.0.0' });

  logger.info('api listening', {
    port: config.port,
    env: config.env,
    docs: `http://localhost:${config.port}/docs`,
  });
}

bootstrap().catch((error: unknown) => {
  // Nothing is wired up yet, so there is no logger to route this through and
  // console is the only thing guaranteed to work.
  console.error('failed to start', error);
  process.exit(1);
});
