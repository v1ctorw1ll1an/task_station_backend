import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class MoveProjectDto {
  @ApiProperty({ description: 'ID do workspace de destino' })
  @IsUUID()
  targetWorkspaceId: string;
}
