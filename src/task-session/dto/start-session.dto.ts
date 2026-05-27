import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class StartSessionDto {
  @ApiProperty({ description: 'ID da task a ser iniciada' })
  @IsUUID('4')
  taskId: string;
}
