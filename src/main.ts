import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  // `bodyParser: false` desativa o parser default do Nest — registramos o
  // nosso abaixo com limite explícito para evitar payloads JSON enormes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });

  // Substitui o logger padrão do NestJS pelo pino em todo o ciclo de vida
  app.useLogger(app.get(Logger));

  app.use(helmet());
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ limit: '1mb', extended: true }));

  const frontendUrl =
    process.env.NODE_ENV === 'production'
      ? (process.env.FRONTEND_URL ??
        (() => {
          throw new Error('FRONTEND_URL is required in production');
        })())
      : (process.env.FRONTEND_URL ?? 'http://localhost:3001');

  app.enableCors({
    origin: frontendUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));

  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('TaskDY API')
      .setDescription('API de gestão de projetos e tasks')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`Application running on http://localhost:${port}/api/v1`, 'Bootstrap');
  if (process.env.NODE_ENV !== 'production') {
    logger.log(`Swagger UI available at http://localhost:${port}/api/docs`, 'Bootstrap');
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
bootstrap();
