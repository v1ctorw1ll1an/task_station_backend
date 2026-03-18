import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class ToggleSuperuserDto {
  @ApiProperty({ description: 'Promover ou revogar status de superusuário' })
  @IsBoolean()
  isSuperuser: boolean;
}
