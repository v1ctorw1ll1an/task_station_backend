import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SuperuserGuard } from '../superadmin/guards/superuser.guard';
import { SkipBillingGate } from './decorators/skip-billing-gate.decorator';
import {
  AdjustSeatsDto,
  CancelSubscriptionDto,
  CourtesyDto,
  ExtendTrialDto,
  ListSubscriptionsQueryDto,
  ListWebhooksQueryDto,
  SetReadonlyDto,
  SuspendAccessDto,
} from './dto/superadmin-billing.dto';
import { SuperadminBillingService } from './superadmin-billing.service';

@ApiTags('superadmin-financeiro')
@ApiBearerAuth()
@UseGuards(SuperuserGuard)
@SkipBillingGate()
@Controller('superadmin/financeiro')
export class SuperadminBillingController {
  constructor(private readonly service: SuperadminBillingService) {}

  @Get('resumo')
  @ApiOperation({ summary: 'Resumo financeiro: MRR, recebido no mês, inadimplência, renovações' })
  getRevenueSummary() {
    return this.service.getRevenueSummary();
  }

  @Get('assinaturas')
  @ApiOperation({ summary: 'Listar assinaturas de todas as empresas (com filtros)' })
  listSubscriptions(@Query() query: ListSubscriptionsQueryDto) {
    return this.service.listSubscriptions(query);
  }

  @Get('webhooks')
  @ApiOperation({ summary: 'Log de eventos de webhook do Asaas (recebidos/processados/falhos)' })
  listWebhooks(@Query() query: ListWebhooksQueryDto) {
    return this.service.listWebhooks(query);
  }

  @Get('webhooks/:id')
  @ApiOperation({ summary: 'Detalhe de um evento de webhook (com payload completo)' })
  async getWebhook(@Param('id') id: string) {
    const event = await this.service.getWebhookEvent(id);
    if (!event) throw new NotFoundException('Evento de webhook não encontrado');
    return event;
  }

  @Post('webhooks/:id/reprocessar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reprocessar um evento de webhook (falho, morto ou já processado)' })
  reprocessWebhook(@Param('id') id: string) {
    return this.service.reprocessWebhook(id);
  }

  @Get('empresas/:companyId')
  @ApiOperation({ summary: 'Detalhe financeiro de uma empresa (assinatura + cobranças)' })
  getCompanyDetail(@Param('companyId') companyId: string) {
    return this.service.getCompanyDetail(companyId);
  }

  @Post('empresas/:companyId/assentos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ajustar os assentos do PLANO (aumento gera Pix de valor cheio, salvo cortesia)',
  })
  adjustSeats(@Param('companyId') companyId: string, @Body() dto: AdjustSeatsDto) {
    return this.service.adjustSeats(companyId, dto);
  }

  @Post('empresas/:companyId/assentos-anuais/:addonId/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Encerrar uma assinatura de assentos anuais (o cliente não tem essa opção)',
  })
  cancelSeatAddon(@Param('companyId') companyId: string, @Param('addonId') addonId: string) {
    return this.service.cancelSeatAddon(companyId, addonId);
  }

  @Post('empresas/:companyId/cortesia')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Conceder ou revogar cortesia (isenção)' })
  setCourtesy(@Param('companyId') companyId: string, @Body() dto: CourtesyDto) {
    return this.service.setCourtesy(companyId, dto);
  }

  @Post('empresas/:companyId/trial')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Estender ou conceder trial' })
  extendTrial(@Param('companyId') companyId: string, @Body() dto: ExtendTrialDto) {
    return this.service.extendTrial(companyId, dto);
  }

  @Post('empresas/:companyId/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar a assinatura (no fim do ciclo ou imediatamente)' })
  cancel(@Param('companyId') companyId: string, @Body() dto: CancelSubscriptionDto) {
    return this.service.cancel(companyId, dto);
  }

  @Post('empresas/:companyId/suspender')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspender o acesso total da empresa (fraude/abuso) ou devolver' })
  suspendAccess(@Param('companyId') companyId: string, @Body() dto: SuspendAccessDto) {
    return this.service.suspendAccess(companyId, dto);
  }

  @Post('empresas/:companyId/readonly')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Forçar ou liberar o modo somente-leitura manual' })
  setReadonly(@Param('companyId') companyId: string, @Body() dto: SetReadonlyDto) {
    return this.service.setReadonly(companyId, dto);
  }
}
