import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { CreateChecklistDto } from '../projeto/dto/create-checklist.dto';
import { UpdateChecklistDto } from '../projeto/dto/update-checklist.dto';
import { ReorderChecklistDto } from '../projeto/dto/reorder-checklist.dto';
import { CreateCommentDto } from '../projeto/dto/create-comment.dto';
import { UpdateCommentDto } from '../projeto/dto/update-comment.dto';
import { UpdateTaskPublicDto } from './dto/update-task-public.dto';
import { GuestContext, GuestTokenGuard } from './guards/guest-token.guard';
import { TaskGuestService } from './task-guest.service';

interface GuestRequest {
  guestContext: GuestContext;
}

@ApiTags('public-tasks')
@Public()
@UseGuards(GuestTokenGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Controller('public/tasks/:token')
export class TaskGuestPublicController {
  constructor(private readonly service: TaskGuestService) {}

  @Get()
  @ApiOperation({ summary: 'Visualiza a task via link público de convidado' })
  @ApiResponse({ status: 200, description: 'Task pública' })
  @ApiResponse({ status: 404, description: 'Link inválido' })
  getTask(@Req() req: GuestRequest) {
    return this.service.getPublicTask(req.guestContext);
  }

  @Patch()
  @ApiOperation({ summary: 'Atualiza campos permitidos da task via link público' })
  @ApiResponse({ status: 200, description: 'Task atualizada' })
  @ApiResponse({ status: 400, description: 'Dados inválidos' })
  @ApiResponse({ status: 404, description: 'Link inválido' })
  updateTask(@Req() req: GuestRequest, @Body() dto: UpdateTaskPublicDto) {
    return this.service.updatePublicTask(req.guestContext, dto);
  }

  // ── Colunas & Labels do projeto (para pickers) ──────────────────────────────

  @Get('columns')
  @ApiOperation({ summary: 'Lista as colunas do projeto da task' })
  getColumns(@Req() req: GuestRequest) {
    return this.service.getPublicColumns(req.guestContext);
  }

  @Get('labels')
  @ApiOperation({ summary: 'Lista a paleta de labels do projeto da task' })
  getLabels(@Req() req: GuestRequest) {
    return this.service.getPublicLabels(req.guestContext);
  }

  // ── Checklist ───────────────────────────────────────────────────────────────

  @Get('checklists')
  listChecklists(@Req() req: GuestRequest) {
    return this.service.listPublicChecklists(req.guestContext);
  }

  @Post('checklists')
  createChecklist(@Req() req: GuestRequest, @Body() dto: CreateChecklistDto) {
    return this.service.createPublicChecklist(req.guestContext, dto);
  }

  @Patch('checklists/reorder')
  reorderChecklists(@Req() req: GuestRequest, @Body() dto: ReorderChecklistDto) {
    return this.service.reorderPublicChecklists(req.guestContext, dto);
  }

  @Patch('checklists/:checklistId')
  updateChecklist(
    @Req() req: GuestRequest,
    @Param('checklistId') checklistId: string,
    @Body() dto: UpdateChecklistDto,
  ) {
    return this.service.updatePublicChecklist(req.guestContext, checklistId, dto);
  }

  @Delete('checklists/:checklistId')
  deleteChecklist(@Req() req: GuestRequest, @Param('checklistId') checklistId: string) {
    return this.service.deletePublicChecklist(req.guestContext, checklistId);
  }

  // ── Comentários ───────────────────────────────────────────────────────────────

  @Get('comments')
  listComments(@Req() req: GuestRequest) {
    return this.service.listPublicComments(req.guestContext);
  }

  @Post('comments')
  createComment(@Req() req: GuestRequest, @Body() dto: CreateCommentDto) {
    return this.service.createPublicComment(req.guestContext, dto);
  }

  @Patch('comments/:commentId')
  updateComment(
    @Req() req: GuestRequest,
    @Param('commentId') commentId: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.service.updateOwnPublicComment(req.guestContext, commentId, dto);
  }

  @Delete('comments/:commentId')
  deleteComment(@Req() req: GuestRequest, @Param('commentId') commentId: string) {
    return this.service.deleteOwnPublicComment(req.guestContext, commentId);
  }

  // ── Histórico ────────────────────────────────────────────────────────────────

  @Get('history')
  getHistory(
    @Req() req: GuestRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const p = Math.max(1, parseInt(page ?? '1', 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit ?? '20', 10) || 20));
    return this.service.listPublicHistory(req.guestContext, p, l);
  }
}
