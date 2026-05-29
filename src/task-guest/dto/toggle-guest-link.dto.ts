import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class ToggleGuestLinkDto {
  @ApiProperty({ description: 'Habilita (true) ou desabilita (false) o link público do convidado' })
  @IsBoolean()
  enabled: boolean;
}
