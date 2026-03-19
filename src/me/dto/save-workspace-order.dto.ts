import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID } from 'class-validator';

export class SaveWorkspaceOrderDto {
  @ApiProperty({ description: 'ID da empresa' })
  @IsUUID()
  companyId: string;

  @ApiProperty({ description: 'IDs dos workspaces em ordem', type: [String] })
  @IsArray()
  @IsUUID('4', { each: true })
  workspaceIds: string[];
}
