import { Module, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, HttpAdapterHost } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserAwareThrottlerGuard } from './common/guards/user-throttler.guard';
import { BillingGateGuard } from './billing/guards/billing-gate.guard';
import { Logger, LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { EmpresaModule } from './empresa/empresa.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { HealthModule } from './health/health.module';
import { MailerModule } from './mailer/mailer.module';
import { MeModule } from './me/me.module';
import { MetricsModule } from './metrics/metrics.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjetoModule } from './projeto/projeto.module';
import { SuperadminModule } from './superadmin/superadmin.module';
import { NotificacaoModule } from './notificacao/notificacao.module';
import { UploadModule } from './upload/upload.module';
import { TaskSessionModule } from './task-session/task-session.module';
import { StickyNotesModule } from './sticky-notes/sticky-notes.module';
import { EventoModule } from './evento/evento.module';
import { TaskGuestModule } from './task-guest/task-guest.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { BillingModule } from './billing/billing.module';
import { ConviteModule } from './convite/convite.module';

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
          // O default do nestjs-pino ainda é `path: '*'`, sintaxe que o
          // path-to-regexp do Express 5 não aceita — o Nest converte na mão e
          // avisa duas vezes no boot (um aviso por middleware do logger).
          // `{*path}` é exatamente o que a conversão produz, então o
          // comportamento é o mesmo, sem o aviso.
          forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
          pinoHttp: {
            level,
            // Gera um requestId UUID para cada request — usado para correlação no Grafana
            genReqId: () => crypto.randomUUID(),
            // Omite campos sensíveis dos logs
            serializers: {
              req(req: { id: string; method: string; url: string; remoteAddress: string }) {
                return {
                  id: req.id,
                  method: req.method,
                  url: req.url,
                  remoteAddress: req.remoteAddress,
                };
              },
              res(res: { statusCode: number }) {
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
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'default',
          limit: 1000,
          ttl: 60_000, // 1 min
        },
      ],
      errorMessage: 'Muitas requisições. Tente novamente em alguns instantes.',
    }),
    PrismaModule,
    MetricsModule,
    MailerModule,
    HealthModule,
    AuthModule,
    SuperadminModule,
    EmpresaModule,
    WorkspaceModule,
    MeModule,
    ProjetoModule,
    NotificacaoModule,
    UploadModule,
    TaskSessionModule,
    StickyNotesModule,
    EventoModule,
    TaskGuestModule,
    MaintenanceModule,
    BillingModule,
    ConviteModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: UserAwareThrottlerGuard,
    },
    {
      // Gate de escrita: bloqueia mutações de empresas em somente-leitura.
      // Roda após o JwtAuthGuard (usuário já resolvido).
      provide: APP_GUARD,
      useClass: BillingGateGuard,
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
