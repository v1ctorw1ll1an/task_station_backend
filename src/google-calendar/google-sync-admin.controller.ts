import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { SuperuserGuard } from '../superadmin/guards/superuser.guard';
import { UpdateGoogleSyncDirectionDto } from './dto/google-calendar.dto';
import { GoogleSyncAdminService } from './google-sync-admin.service';

/** Controle global da integração com o Google Agenda (só superusuário). */
@ApiTags('superadmin')
@ApiBearerAuth()
@UseGuards(SuperuserGuard)
@Controller('superadmin/integrations/google')
export class GoogleSyncAdminController {
  constructor(private readonly admin: GoogleSyncAdminService) {}

  @Get()
  @ApiOperation({ summary: 'Direção da sincronização e saúde da integração' })
  panel() {
    return this.admin.getPanel();
  }

  @Patch('direction')
  // Cada troca agenda um resync completo de todas as conexões.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Define a direção: ambos, só Google → app ou só app → Google' })
  setDirection(@CurrentUser() user: AuthUser, @Body() dto: UpdateGoogleSyncDirectionDto) {
    return this.admin.setDirection(dto.direction, user.id);
  }
}
