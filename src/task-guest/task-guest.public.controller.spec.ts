import { TaskGuestPublicController } from './task-guest.public.controller';
import { TaskGuestService } from './task-guest.service';

function makeService(overrides: Partial<Record<keyof TaskGuestService, jest.Mock>> = {}) {
  return {
    getPublicTask: jest.fn(),
    updatePublicTask: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<TaskGuestService>;
}

const ctx = { guestId: 'g1', taskId: 'task-1', projectId: 'project-1' };

describe('TaskGuestPublicController', () => {
  // GET delega ao service com guestContext anexado pelo guard
  it('GET delega ao service.getPublicTask com guestContext', async () => {
    const service = makeService({ getPublicTask: jest.fn().mockResolvedValue({ id: 'task-1' }) });
    const controller = new TaskGuestPublicController(service);

    const result = await controller.getTask({ guestContext: ctx });

    expect(service.getPublicTask).toHaveBeenCalledWith(ctx);
    expect(result).toEqual({ id: 'task-1' });
  });

  // PATCH delega ao service.updatePublicTask com guestContext + dto
  it('PATCH delega ao service.updatePublicTask com guestContext e dto', async () => {
    const service = makeService({
      updatePublicTask: jest.fn().mockResolvedValue({ id: 'task-1', title: 'novo' }),
    });
    const controller = new TaskGuestPublicController(service);

    const result = await controller.updateTask({ guestContext: ctx }, { title: 'novo' });

    expect(service.updatePublicTask).toHaveBeenCalledWith(ctx, { title: 'novo' });
    expect(result).toEqual({ id: 'task-1', title: 'novo' });
  });
});
