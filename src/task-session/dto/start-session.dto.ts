import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class StartSessionDto {
  @ApiProperty({ description: 'ID da task a ser iniciada' })
  @IsString()
  @IsNotEmpty()
  taskId: string;
}
