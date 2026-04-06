import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Request,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { ProjetoAdminGuard } from './guards/projeto-admin.guard';
import { ProjetoMemberGuard } from './guards/projeto-member.guard';
import { ProjetoService } from './projeto.service';
import { AttachmentService } from './attachment.service';
import { CreateColunaDto } from './dto/create-coluna.dto';
import { UpdateColunaDto } from './dto/update-coluna.dto';
import { ReorderColunasDto } from './dto/reorder-colunas.dto';
import { DeleteColunaDto } from './dto/delete-coluna.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { MoveTaskDto } from './dto/move-task.dto';
import { AssignTaskDto } from './dto/assign-task.dto';
import { TransferTaskDto } from './dto/transfer-task.dto';
import { CreateLabelDto } from './dto/create-label.dto';
import { UpdateLabelDto } from './dto/update-label.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';

@ApiTags('projetos')
@ApiBearerAuth()
@UseGuards(ProjetoMemberGuard)
@Controller('projetos/:projectId')
export class ProjetoController {
  constructor(
    private readonly projetoService: ProjetoService,
    private readonly attachmentService: AttachmentService,
  ) {}

  // ── Kanban ────────────────────────────────────────────────────────────────────

  @Get('kanban')
  @ApiOperation({ summary: 'Retorna colunas e tasks do projeto (Kanban)' })
  @ApiResponse({ status: 200, description: 'Kanban retornado com sucesso' })
  @ApiResponse({ status: 404, description: 'Projeto não encontrado' })
  getKanban(@Param('projectId') projectId: string) {
    return this.projetoService.getKanban(projectId);
  }

  @Get('membros')
  @ApiOperation({ summary: 'Listar membros do workspace para seleção de responsável' })
  @ApiResponse({ status: 200, description: 'Lista de membros ativos' })
  listMembers(@Param('projectId') projectId: string) {
    return this.projetoService.listMembers(projectId);
  }

  @Get('last-modified')
  @ApiOperation({ summary: 'Timestamp da última alteração no projeto (polling de sync)' })
  @ApiResponse({ status: 200, description: 'lastModifiedAt retornado' })
  getLastModified(@Param('projectId') projectId: string) {
    return this.projetoService.getProjectLastModifiedAt(projectId);
  }

  // ── Colunas ───────────────────────────────────────────────────────────────────

  @Post('colunas')
  @UseGuards(ProjetoAdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Criar nova coluna no projeto' })
  @ApiResponse({ status: 201, description: 'Coluna criada' })
  createColuna(
    @Param('projectId') projectId: string,
    @Body() dto: CreateColunaDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.createColuna(projectId, dto, user.id);
  }

  @Patch('colunas/reorder')
  @UseGuards(ProjetoAdminGuard)
  @ApiOperation({ summary: 'Reordenar colunas do projeto' })
  @ApiResponse({ status: 200, description: 'Colunas reordenadas' })
  reorderColunas(
    @Param('projectId') projectId: string,
    @Body() dto: ReorderColunasDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.reorderColunas(projectId, dto, user.id);
  }

  @Patch('colunas/:columnId')
  @UseGuards(ProjetoAdminGuard)
  @ApiOperation({ summary: 'Editar nome ou cor de uma coluna' })
  @ApiResponse({ status: 200, description: 'Coluna atualizada' })
  @ApiResponse({ status: 404, description: 'Coluna não encontrada' })
  updateColuna(
    @Param('projectId') projectId: string,
    @Param('columnId') columnId: string,
    @Body() dto: UpdateColunaDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.updateColuna(projectId, columnId, dto, user.id);
  }

  @Delete('colunas/:columnId')
  @UseGuards(ProjetoAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete de coluna (migra tasks se necessário)' })
  @ApiResponse({ status: 204, description: 'Coluna removida' })
  @ApiResponse({ status: 400, description: 'Coluna tem tasks e sem coluna de destino' })
  @ApiResponse({ status: 404, description: 'Coluna não encontrada' })
  async deleteColuna(
    @Param('projectId') projectId: string,
    @Param('columnId') columnId: string,
    @Body() dto: DeleteColunaDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.projetoService.deleteColuna(projectId, columnId, dto, user.id);
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────────

  @Post('tasks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Criar task no projeto' })
  @ApiResponse({ status: 201, description: 'Task criada' })
  createTask(
    @Param('projectId') projectId: string,
    @Body() dto: CreateTaskDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.createTask(projectId, dto, user.id);
  }

  @Patch('tasks/:taskId')
  @ApiOperation({ summary: 'Editar task' })
  @ApiResponse({ status: 200, description: 'Task atualizada' })
  @ApiResponse({ status: 404, description: 'Task não encontrada' })
  updateTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() dto: UpdateTaskDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.updateTask(projectId, taskId, dto, user.id);
  }

  @Patch('tasks/:taskId/move')
  @ApiOperation({ summary: 'Mover task para outra coluna ou reordenar' })
  @ApiResponse({ status: 200, description: 'Task movida' })
  @ApiResponse({ status: 404, description: 'Task ou coluna não encontrada' })
  moveTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() dto: MoveTaskDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.moveTask(projectId, taskId, dto, user.id);
  }

  @Get('tasks/deleted')
  @UseGuards(ProjetoAdminGuard)
  @ApiOperation({ summary: 'Lista tasks deletadas do projeto (lixeira)' })
  @ApiResponse({ status: 200, description: 'Tasks deletadas retornadas' })
  getDeletedTasks(@Param('projectId') projectId: string) {
    return this.projetoService.getDeletedTasks(projectId);
  }

  @Patch('tasks/:taskId/restore')
  @UseGuards(ProjetoAdminGuard)
  @ApiOperation({ summary: 'Restaura task da lixeira' })
  @ApiResponse({ status: 200, description: 'Task restaurada' })
  @ApiResponse({ status: 404, description: 'Task não encontrada na lixeira' })
  restoreTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.restoreTask(projectId, taskId, user.id);
  }

  @Delete('tasks/:taskId')
  @UseGuards(ProjetoAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete de task' })
  @ApiResponse({ status: 204, description: 'Task removida' })
  @ApiResponse({ status: 404, description: 'Task não encontrada' })
  async deleteTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.projetoService.deleteTask(projectId, taskId, user.id);
  }

  @Get('tasks/:taskId/history')
  @ApiOperation({ summary: 'Histórico de alterações da task' })
  @ApiResponse({ status: 200, description: 'Histórico retornado com sucesso' })
  @ApiResponse({ status: 404, description: 'Task não encontrada' })
  getTaskHistory(@Param('projectId') projectId: string, @Param('taskId') taskId: string) {
    return this.projetoService.getTaskHistory(projectId, taskId);
  }

  @Patch('tasks/:taskId/assign')
  @ApiOperation({ summary: 'Atribuir ou remover responsável da task' })
  @ApiResponse({ status: 200, description: 'Responsável atualizado' })
  @ApiResponse({ status: 404, description: 'Task não encontrada' })
  assignTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() dto: AssignTaskDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.assignTask(projectId, taskId, dto, user.id);
  }

  // ── Transfer ──────────────────────────────────────────────────────────────────

  @Get('transfer-targets')
  @ApiOperation({ summary: 'Lista projetos disponíveis para transferência de task' })
  @ApiResponse({ status: 200, description: 'Lista de projetos agrupados por workspace' })
  getTransferTargets(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.projetoService.getTransferTargets(projectId, user.id);
  }

  @Post('tasks/:taskId/transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Copiar ou recortar task para outro projeto' })
  @ApiResponse({ status: 200, description: 'Task transferida com sucesso' })
  @ApiResponse({ status: 403, description: 'Sem acesso ao projeto de destino' })
  @ApiResponse({ status: 404, description: 'Task, projeto ou coluna não encontrados' })
  transferTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() dto: TransferTaskDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.transferTask(projectId, taskId, dto, user.id);
  }

  // ── Labels ────────────────────────────────────────────────────────────────────

  @Get('labels')
  @ApiOperation({ summary: 'Listar labels do projeto' })
  @ApiResponse({ status: 200, description: 'Lista de labels' })
  listLabels(@Param('projectId') projectId: string) {
    return this.projetoService.listLabels(projectId);
  }

  @Post('labels')
  @UseGuards(ProjetoAdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Criar label no projeto' })
  @ApiResponse({ status: 201, description: 'Label criada' })
  @ApiResponse({ status: 409, description: 'Label com este nome já existe' })
  createLabel(
    @Param('projectId') projectId: string,
    @Body() dto: CreateLabelDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.createLabel(projectId, dto, user.id);
  }

  @Patch('labels/:labelId')
  @UseGuards(ProjetoAdminGuard)
  @ApiOperation({ summary: 'Editar label' })
  @ApiResponse({ status: 200, description: 'Label atualizada' })
  @ApiResponse({ status: 404, description: 'Label não encontrada' })
  updateLabel(
    @Param('projectId') projectId: string,
    @Param('labelId') labelId: string,
    @Body() dto: UpdateLabelDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.updateLabel(projectId, labelId, dto, user.id);
  }

  @Delete('labels/:labelId')
  @UseGuards(ProjetoAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete de label' })
  @ApiResponse({ status: 204, description: 'Label removida' })
  @ApiResponse({ status: 404, description: 'Label não encontrada' })
  async deleteLabel(
    @Param('projectId') projectId: string,
    @Param('labelId') labelId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.projetoService.deleteLabel(projectId, labelId, user.id);
  }

  // ── Comentários ───────────────────────────────────────────────────────────────

  @Get('tasks/:taskId/comments')
  @ApiOperation({ summary: 'Listar comentários da task' })
  @ApiResponse({ status: 200, description: 'Comentários retornados' })
  @ApiResponse({ status: 404, description: 'Task não encontrada' })
  listComments(@Param('projectId') projectId: string, @Param('taskId') taskId: string) {
    return this.projetoService.listComments(projectId, taskId);
  }

  @Post('tasks/:taskId/comments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Criar comentário na task' })
  @ApiResponse({ status: 201, description: 'Comentário criado' })
  @ApiResponse({ status: 404, description: 'Task não encontrada' })
  createComment(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.createComment(projectId, taskId, dto, user.id);
  }

  @Patch('tasks/:taskId/comments/:commentId')
  @ApiOperation({ summary: 'Editar comentário (apenas autor ou admin)' })
  @ApiResponse({ status: 200, description: 'Comentário atualizado' })
  @ApiResponse({ status: 403, description: 'Sem permissão para editar' })
  @ApiResponse({ status: 404, description: 'Comentário não encontrado' })
  updateComment(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Param('commentId') commentId: string,
    @Body() dto: UpdateCommentDto,
    @CurrentUser() user: AuthUser,
    @Request() req: { projectMemberRole?: string },
  ) {
    const isAdmin =
      req.projectMemberRole === 'workspace_admin' || req.projectMemberRole === 'project_admin';
    return this.projetoService.updateComment(projectId, taskId, commentId, dto, user.id, isAdmin);
  }

  @Delete('tasks/:taskId/comments/:commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Excluir comentário (apenas autor ou admin)' })
  @ApiResponse({ status: 204, description: 'Comentário removido' })
  @ApiResponse({ status: 403, description: 'Sem permissão para excluir' })
  @ApiResponse({ status: 404, description: 'Comentário não encontrado' })
  async deleteComment(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Param('commentId') commentId: string,
    @CurrentUser() user: AuthUser,
    @Request() req: { projectMemberRole?: string },
  ) {
    const isAdmin =
      req.projectMemberRole === 'workspace_admin' || req.projectMemberRole === 'project_admin';
    await this.projetoService.deleteComment(projectId, taskId, commentId, user.id, isAdmin);
  }

  // ── Anexos ────────────────────────────────────────────────────────────────────

  @Get('tasks/:taskId/attachments')
  @ApiOperation({ summary: 'Listar anexos da task' })
  @ApiResponse({ status: 200, description: 'Anexos retornados' })
  listAttachments(@Param('taskId') taskId: string) {
    return this.attachmentService.listAttachments(taskId);
  }

  @Post('tasks/:taskId/attachments')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', { storage: undefined, limits: { fileSize: 64 * 1024 * 1024 } }),
  )
  @ApiOperation({ summary: 'Upload de anexo (imagem ou vídeo)' })
  @ApiResponse({ status: 201, description: 'Anexo salvo' })
  uploadAttachment(
    @Param('taskId') taskId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthUser,
  ) {
    return this.attachmentService.upload(taskId, file, user.id);
  }

  @Get('tasks/:taskId/attachments/:attachmentId/thumbnail')
  @ApiOperation({ summary: 'Serve thumbnail do anexo (baixa resolução)' })
  async serveAttachmentThumbnail(
    @Param('taskId') taskId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ) {
    const att = await this.attachmentService.findAttachmentById(attachmentId, taskId);
    if (!att) {
      res.status(404).json({ message: 'Anexo não encontrado' });
      return;
    }
    const isVideo = att.mimeType.startsWith('video/');
    const filePath = this.attachmentService.serveThumbnail(taskId, att.storedName, isVideo);
    const contentType = isVideo ? 'image/jpeg' : 'image/webp';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    createReadStream(filePath).pipe(res);
  }

  @Get('tasks/:taskId/attachments/:attachmentId/file')
  @ApiOperation({ summary: 'Serve arquivo completo do anexo' })
  async serveAttachmentFile(
    @Param('taskId') taskId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ) {
    const att = await this.attachmentService.findAttachmentById(attachmentId, taskId);
    if (!att) {
      res.status(404).json({ message: 'Anexo não encontrado' });
      return;
    }
    const filePath = this.attachmentService.serveFile(taskId, att.storedName);
    res.setHeader('Content-Type', att.mimeType.startsWith('video/') ? att.mimeType : 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    createReadStream(filePath).pipe(res);
  }

  @Delete('tasks/:taskId/attachments/:attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remover anexo da task' })
  @ApiResponse({ status: 204, description: 'Anexo removido' })
  async deleteAttachment(
    @Param('taskId') taskId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.attachmentService.deleteAttachment(attachmentId, taskId, user.id);
  }
}
