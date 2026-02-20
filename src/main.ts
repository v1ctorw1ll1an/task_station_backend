import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Substitui o logger padrão do NestJS pelo pino em todo o ciclo de vida
  app.useLogger(app.get(Logger));

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));

  const config = new DocumentBuilder()
    .setTitle('Task Station API')
    .setDescription('API de gestão de projetos e tasks')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`Application running on http://localhost:${port}/api/v1`, 'Bootstrap');
  logger.log(`Swagger UI available at http://localhost:${port}/api/docs`, 'Bootstrap');
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
bootstrap();
