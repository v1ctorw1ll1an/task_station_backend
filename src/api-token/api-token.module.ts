import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ApiTokenController } from './api-token.controller';
import { ApiTokenRepository } from './api-token.repository';
import { ApiTokenService } from './api-token.service';

/**
 * Exporta o service para o `JwtAuthGuard` global (registrado no `AppModule`), que
 * autentica o PAT. A limitação fica no `ApiTokenScopeGuard`, também global.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ApiTokenController],
  providers: [ApiTokenRepository, ApiTokenService],
  exports: [ApiTokenService],
})
export class ApiTokenModule {}
