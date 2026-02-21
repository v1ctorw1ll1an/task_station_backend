import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class PromoteMemberDto {
  @ApiProperty({ example: 'uuid-do-usuario', format: 'uuid' })
  @IsUUID()
  userId: string;
}
