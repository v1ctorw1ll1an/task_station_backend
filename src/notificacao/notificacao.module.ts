import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { NotificacaoRepository } from './notificacao.repository';
import { NotificacaoService } from './notificacao.service';
import { NotificacaoGateway } from './notificacao.gateway';
import { NotificacaoController } from './notificacao.controller';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [NotificacaoRepository, NotificacaoService, NotificacaoGateway],
  controllers: [NotificacaoController],
  exports: [NotificacaoService],
})
export class NotificacaoModule {}
