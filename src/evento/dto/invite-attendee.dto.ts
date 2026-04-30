import { IsUUID } from 'class-validator';

export class InviteAttendeeDto {
  @IsUUID('4')
  userId: string;
}
