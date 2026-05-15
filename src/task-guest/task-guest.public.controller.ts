import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
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
}
