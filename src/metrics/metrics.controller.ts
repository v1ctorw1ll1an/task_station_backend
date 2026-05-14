import { Controller, Get, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PrometheusController } from '@willsoto/nestjs-prometheus';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';

@SkipThrottle()
@Public()
@Controller('metrics')
export class MetricsController extends PrometheusController {
  @Get()
  index(@Res({ passthrough: true }) response: Response): Promise<string> {
    return super.index(response);
  }
}
