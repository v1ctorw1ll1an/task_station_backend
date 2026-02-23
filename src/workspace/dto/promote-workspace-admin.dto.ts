import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class PromoteWorkspaceAdminDto {
  @ApiProperty({ example: 'uuid-do-usuario' })
  @IsUUID()
  userId: string;
}
