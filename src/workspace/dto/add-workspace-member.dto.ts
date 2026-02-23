import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AddWorkspaceMemberDto {
  @ApiProperty({ example: 'uuid-do-usuario' })
  @IsUUID()
  userId: string;
}
