import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CepService } from '../common/cep/cep.service';
import { CompanyAdminGuard } from '../empresa/guards/company-admin.guard';
import { BillingService } from './billing.service';
import { SkipBillingGate } from './decorators/skip-billing-gate.decorator';
import { BillingPreviewQueryDto } from './dto/billing-preview-query.dto';
import { ListChargesQueryDto } from './dto/list-charges-query.dto';
import { BuySeatsDto, ReduceSeatsDto, SeatPreviewQueryDto } from './dto/seats.dto';
import { SubscribeAnnualCardDto } from './dto/subscribe-annual-card.dto';
import { SubscribeAnnualPixDto } from './dto/subscribe-annual-pix.dto';
import { SubscribeMonthlyDto } from './dto/subscribe-monthly.dto';
import { UpdateBillingAddressDto } from './dto/update-billing-address.dto';

@ApiTags('billing')
@ApiBearerAuth()
@UseGuards(CompanyAdminGuard)
@SkipBillingGate()
@Controller('billing/empresa/:companyId')
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly cepService: CepService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Status de cobrança da empresa (assinatura + assentos + Pix pendente)' })
  @ApiResponse({ status: 200, description: 'Status de cobrança' })
  getStatus(@Param('companyId') companyId: string) {
    return this.billingService.getStatus(companyId);
  }

  @Get('preview')
  @ApiOperation({ summary: 'Simular preço de um método/quantidade de assentos' })
  getPreview(@Query() query: BillingPreviewQueryDto) {
    return this.billingService.getPreview(query);
  }

  @Get('cep/:cep')
  // Consulta externa (ViaCEP): folga para o admin corrigir o cadastro sem virar
  // proxy aberto de consulta de CEP.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Buscar endereço por CEP para preencher os dados de cobrança' })
  @ApiResponse({
    status: 200,
    description: '{ encontrado, endereco } — `encontrado: false` quando o CEP não existe',
  })
  async buscarCep(@Param('cep') cep: string) {
    const endereco = await this.cepService.lookup(cep);
    return { encontrado: endereco != null, endereco };
  }

  @Post('conferir-pagamento')
  @HttpCode(HttpStatus.OK)
  // Bate no Asaas: folga para o cliente insistir algumas vezes enquanto olha o
  // comprovante, sem virar ferramenta de martelar o provedor.
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @ApiOperation({
    summary: '"Já paguei" — confere o pagamento no Asaas agora, sem esperar o webhook',
  })
  @ApiResponse({
    status: 200,
    description: '{ pago, status } — `pago` false = ainda não identificado',
  })
  conferirPagamento(@Param('companyId') companyId: string) {
    return this.billingService.conferirPagamento(companyId);
  }

  @Get('historico')
  @ApiOperation({ summary: 'Histórico paginado de cobranças da empresa' })
  getHistory(@Param('companyId') companyId: string, @Query() query: ListChargesQueryDto) {
    return this.billingService.getHistory(companyId, query);
  }

  @Get('fatura-atraso')
  @ApiOperation({ summary: 'Link da fatura em atraso na página do Asaas (para pagá-la)' })
  @ApiResponse({ status: 200, description: '{ invoiceUrl } — null quando não há atraso' })
  getFaturaEmAtraso(@Param('companyId') companyId: string) {
    return this.billingService.getFaturaEmAtraso(companyId);
  }

  @Post('assinar/mensal')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Assinar o plano mensal — devolve o link do checkout do Asaas' })
  @ApiResponse({ status: 200, description: '{ checkoutUrl, expiresAt, status }' })
  subscribeMonthly(@Param('companyId') companyId: string, @Body() dto: SubscribeMonthlyDto) {
    return this.billingService.subscribeMonthly(companyId, dto);
  }

  @Post('assinar/anual-pix')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Assinar o plano anual via Pix (assinatura anual + QR Code)' })
  subscribeAnnualPix(@Param('companyId') companyId: string, @Body() dto: SubscribeAnnualPixDto) {
    return this.billingService.subscribeAnnualPix(companyId, dto);
  }

  @Post('assinar/anual-cartao')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Assinar o plano anual no cartão (até 12×) — link do checkout' })
  @ApiResponse({ status: 200, description: '{ checkoutUrl, expiresAt, status }' })
  subscribeAnnualCard(@Param('companyId') companyId: string, @Body() dto: SubscribeAnnualCardDto) {
    return this.billingService.subscribeAnnualCard(companyId, dto);
  }

  @Post('assentos/comprar')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Comprar usuários adicionais (valor cheio, sem proração)' })
  @ApiResponse({
    status: 200,
    description: '{ checkoutUrl, status } — `checkoutUrl` null no Pix (o QR vem no status)',
  })
  buySeats(@Param('companyId') companyId: string, @Body() dto: BuySeatsDto) {
    return this.billingService.buySeats(companyId, dto);
  }

  @Get('exportar')
  @SkipBillingGate()
  // Consulta pesada: seguramos, mas com folga para o admin baixar JSON e CSV e
  // ainda repetir se a rede falhar.
  @Throttle({ default: { limit: 6, ttl: 3_600_000 } })
  @ApiOperation({
    summary: 'Exportar os dados da empresa (JSON ou CSV) — disponível mesmo bloqueada',
  })
  async exportar(
    @Param('companyId') companyId: string,
    @Query('formato') formato: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { filename, mime, body } = await this.billingService.exportCompany(
      companyId,
      formato === 'csv' ? 'csv' : 'json',
    );
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return body;
  }

  @Get('assentos/preview')
  @ApiOperation({ summary: 'Simular o efeito de comprar/reduzir usuários antes de confirmar' })
  previewSeatChange(@Param('companyId') companyId: string, @Query() query: SeatPreviewQueryDto) {
    return this.billingService.previewSeatChange(companyId, query.quantity, query);
  }

  @Post('assentos/cancelar-pendente')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Cancelar a cobrança de usuários em aberto (para trocar a forma de pagamento)',
  })
  cancelPendingSeatCharge(@Param('companyId') companyId: string) {
    return this.billingService.cancelPendingSeatCharge(companyId);
  }

  @Get('assentos/membros')
  @ApiOperation({ summary: 'Membros que ocupam assento (para escolher quem sai ao reduzir)' })
  getSeatHolders(@Param('companyId') companyId: string) {
    return this.billingService.getSeatHolders(companyId);
  }

  @Post('assentos/reduzir')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Reduzir usuários (só no plano mensal; vale na próxima renovação)',
  })
  reduceSeats(@Param('companyId') companyId: string, @Body() dto: ReduceSeatsDto) {
    return this.billingService.reduceSeats(companyId, dto);
  }

  @Post('cancelar')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Cancelar a assinatura (o acesso segue até o fim do ciclo pago)' })
  cancel(@Param('companyId') companyId: string) {
    return this.billingService.cancel(companyId);
  }

  @Post('cartao/trocar')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Trocar o cartão da assinatura mensal — devolve o link do checkout do Asaas',
  })
  @ApiResponse({ status: 200, description: '{ checkoutUrl, expiresAt, status }' })
  trocarCartao(@Param('companyId') companyId: string) {
    return this.billingService.trocarCartao(companyId);
  }

  @Patch('endereco-cobranca')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Atualizar os dados de cobrança (exigidos antes de qualquer pagamento)',
  })
  updateBillingAddress(
    @Param('companyId') companyId: string,
    @Body() dto: UpdateBillingAddressDto,
  ) {
    return this.billingService.updateBillingAddress(companyId, dto);
  }

  @Post('reativar')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Desfazer um cancelamento agendado (reativar a assinatura)' })
  @ApiResponse({
    status: 200,
    description: '{ checkoutUrl, status } — no mensal o cartão é reinformado no Asaas',
  })
  reactivate(@Param('companyId') companyId: string) {
    return this.billingService.reactivate(companyId);
  }
}
