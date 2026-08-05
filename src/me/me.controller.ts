import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { MeService } from './me.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { ListMyTasksQueryDto } from './dto/list-my-tasks-query.dto';
import { SaveWorkspaceOrderDto } from './dto/save-workspace-order.dto';
import { SaveProjectOrderDto } from './dto/save-project-order.dto';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get('perfil')
  @ApiOperation({ summary: 'Retornar dados do perfil do usuário autenticado' })
  @ApiResponse({ status: 200, description: 'Dados do perfil' })
  getProfile(@CurrentUser() user: AuthUser) {
    return this.meService.getProfile(user.id);
  }

  @Patch('perfil')
  @ApiOperation({ summary: 'Atualizar dados do perfil (nome, telefone, foto)' })
  @ApiResponse({ status: 200, description: 'Perfil atualizado' })
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.meService.updateProfile(user.id, dto);
  }

  @Post('tutorial/concluir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marcar o tutorial de primeiros passos como visto' })
  @ApiResponse({ status: 200, description: 'Tutorial marcado como visto' })
  markTutorialSeen(@CurrentUser() user: AuthUser) {
    return this.meService.markTutorialSeen(user.id);
  }

  @Post('perfil/foto')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('foto', { storage: undefined, limits: { fileSize: 16 * 1024 * 1024 } }),
  )
  @ApiOperation({ summary: 'Upload de foto de perfil' })
  uploadAvatar(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File) {
    return this.meService.uploadAvatar(user.id, file);
  }

  @Public()
  @Get('foto/:userId')
  @ApiOperation({ summary: 'Serve foto de perfil (público)' })
  serveAvatar(@Param('userId') userId: string, @Res() res: Response) {
    const filePath = this.meService.getAvatarPath(userId);
    if (!filePath) {
      res.status(404).json({ message: 'Avatar não encontrado' });
      return;
    }
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    createReadStream(filePath).pipe(res);
  }

  @Patch('perfil/senha')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Alterar senha com confirmação da senha atual' })
  @ApiResponse({ status: 204, description: 'Senha alterada com sucesso' })
  @ApiResponse({ status: 401, description: 'Senha atual incorreta' })
  updatePassword(@CurrentUser() user: AuthUser, @Body() dto: UpdatePasswordDto) {
    return this.meService.updatePassword(user.id, dto);
  }

  @Get('tasks')
  @ApiOperation({ summary: 'Tarefas atribuídas ao usuário (cross-workspace)' })
  @ApiResponse({ status: 200, description: 'Lista paginada de tarefas do usuário' })
  getMyTasks(@CurrentUser() user: AuthUser, @Query() query: ListMyTasksQueryDto) {
    return this.meService.getMyTasks(user.id, query);
  }

  @Get('empresas')
  @ApiOperation({ summary: 'Listar empresas que o usuário administra' })
  @ApiResponse({ status: 200, description: 'Lista de empresas do usuário autenticado' })
  getMyCompanies(@CurrentUser() user: AuthUser) {
    return this.meService.getMyCompanies(user.id);
  }

  @Get('workspaces')
  @ApiOperation({ summary: 'Listar workspaces do usuário (qualquer role)' })
  @ApiResponse({ status: 200, description: 'Lista de workspaces do usuário autenticado' })
  getMyWorkspaces(@CurrentUser() user: AuthUser) {
    return this.meService.getMyWorkspaces(user.id);
  }

  @Get('sidebar-order/:companyId')
  @ApiOperation({ summary: 'Retornar ordem de workspaces e projetos na sidebar do usuário' })
  @ApiResponse({ status: 200, description: 'Ordens salvas pelo usuário' })
  getSidebarOrder(@CurrentUser() user: AuthUser, @Param('companyId') companyId: string) {
    return this.meService.getSidebarOrder(user.id, companyId);
  }

  @Put('workspace-order')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Salvar ordem dos workspaces na sidebar (por usuário)' })
  @ApiResponse({ status: 204, description: 'Ordem salva' })
  async saveWorkspaceOrder(@CurrentUser() user: AuthUser, @Body() dto: SaveWorkspaceOrderDto) {
    await this.meService.saveWorkspaceOrder(user.id, dto);
  }

  @Put('project-order')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Salvar ordem dos projetos na sidebar (por usuário)' })
  @ApiResponse({ status: 204, description: 'Ordem salva' })
  async saveProjectOrder(@CurrentUser() user: AuthUser, @Body() dto: SaveProjectOrderDto) {
    await this.meService.saveProjectOrder(user.id, dto);
  }
}
