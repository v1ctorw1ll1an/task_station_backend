import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, HttpAdapterHost } from '@nestjs/core';
import { Logger, LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { EmpresaModule } from './empresa/empresa.module';
import { HealthModule } from './health/health.module';
import { MailerModule } from './mailer/mailer.module';
import { MeModule } from './me/me.module';
import { PrismaModule } from './prisma/prisma.module';
import { SuperadminModule } from './superadmin/superadmin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isDev = config.get<string>('NODE_ENV') !== 'production';
        const level = config.get<string>('LOG_LEVEL', isDev ? 'debug' : 'info');

        return {
          pinoHttp: {
            level,
            // Gera um requestId UUID para cada request — usado para correlação no Grafana
            genReqId: () => crypto.randomUUID(),
            // Omite campos sensíveis dos logs
            serializers: {
              req(req) {
                return {
                  id: req.id,
                  method: req.method,
                  url: req.url,
                  remoteAddress: req.remoteAddress,
                };
              },
              res(res) {
                return {
                  statusCode: res.statusCode,
                };
              },
            },
            // Em development: pino-pretty com output colorido e legível
            ...(isDev && {
              transport: {
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  singleLine: false,
                  translateTime: 'SYS:HH:MM:ss.l',
                  ignore: 'pid,hostname',
                },
              },
            }),
          },
        };
      },
    }),
    PrismaModule,
    MailerModule,
    HealthModule,
    AuthModule,
    SuperadminModule,
    EmpresaModule,
    MeModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_FILTER,
      useFactory: (httpAdapterHost: HttpAdapterHost, logger: Logger) =>
        new AllExceptionsFilter(httpAdapterHost, logger),
      inject: [HttpAdapterHost, Logger],
    },
  ],
})
export class AppModule {}
