import { IsEnum } from 'class-validator';
import { AttendeeStatus } from '../../generated/prisma/client';

export class RsvpDto {
  @IsEnum(AttendeeStatus)
  status: AttendeeStatus;
}
