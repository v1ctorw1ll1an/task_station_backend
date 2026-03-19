import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID } from 'class-validator';

export class SaveProjectOrderDto {
  @ApiProperty({ description: 'ID do workspace' })
  @IsUUID()
  workspaceId: string;

  @ApiProperty({ description: 'IDs dos projetos em ordem', type: [String] })
  @IsArray()
  @IsUUID('4', { each: true })
  projectIds: string[];
}
