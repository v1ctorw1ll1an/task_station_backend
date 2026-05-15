import { TaskGuestController } from './task-guest.controller';
import { TaskGuestService } from './task-guest.service';
import { AuthUser } from '../auth/strategies/jwt.strategy';

function makeService(overrides: Partial<Record<keyof TaskGuestService, jest.Mock>> = {}) {
  return {
    createGuest: jest.fn(),
    listGuests: jest.fn(),
    revokeGuest: jest.fn(),
    searchGuests: jest.fn(),
    buildGuestNotifyUrl: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<TaskGuestService>;
}

const user: AuthUser = {
  id: 'user-1',
  email: 'u@x.com',
  isSuperuser: false,
  mustResetPassword: false,
} as AuthUser;

describe('TaskGuestController', () => {
  // Garante que o controller delega ao service com taskId e user.id corretos
  it('POST delega ao service.createGuest com taskId e user.id', async () => {
    const service = makeService({
      createGuest: jest
        .fn()
        .mockResolvedValue({ guest: { id: 'g1' }, publicUrl: 'x', whatsappUrl: 'y' }),
    });
    const controller = new TaskGuestController(service);

    const result = await controller.create('task-1', user, { name: 'A', phone: '+5511999999999' });

    expect(service.createGuest).toHaveBeenCalledWith('task-1', 'user-1', {
      name: 'A',
      phone: '+5511999999999',
    });
    expect(result).toEqual({ guest: { id: 'g1' }, publicUrl: 'x', whatsappUrl: 'y' });
  });

  // GET delega para listGuests com taskId
  it('GET delega ao service.listGuests', async () => {
    const service = makeService({ listGuests: jest.fn().mockResolvedValue([{ id: 'g1' }]) });
    const controller = new TaskGuestController(service);

    const result = await controller.list('task-1');

    expect(service.listGuests).toHaveBeenCalledWith('task-1');
    expect(result).toEqual([{ id: 'g1' }]);
  });

  // Search delega para service.searchGuests com projectId e q
  it('GET search delega ao service.searchGuests', async () => {
    const service = makeService({ searchGuests: jest.fn().mockResolvedValue([]) });
    const controller = new TaskGuestController(service);

    await controller.search('project-1', 'jo');

    expect(service.searchGuests).toHaveBeenCalledWith('project-1', 'jo');
  });

  // POST notify delega ao service.buildGuestNotifyUrl com taskId, guestId e historyEntryIds
  it('POST notify delega ao service.buildGuestNotifyUrl', async () => {
    const service = makeService({
      buildGuestNotifyUrl: jest
        .fn()
        .mockResolvedValue({ whatsappUrl: 'https://wa.me/x', fields: ['title'] }),
    });
    const controller = new TaskGuestController(service);

    const result = await controller.notify('task-1', 'g1', { historyEntryIds: ['h1', 'h2'] });

    expect(service.buildGuestNotifyUrl).toHaveBeenCalledWith('task-1', 'g1', ['h1', 'h2']);
    expect(result).toEqual({ whatsappUrl: 'https://wa.me/x', fields: ['title'] });
  });

  // DELETE delega para revokeGuest com taskId e guestId (proteção contra revogar de outra task valida no service)
  it('DELETE delega ao service.revokeGuest', async () => {
    const service = makeService({ revokeGuest: jest.fn().mockResolvedValue(undefined) });
    const controller = new TaskGuestController(service);

    await controller.revoke('task-1', 'g1');

    expect(service.revokeGuest).toHaveBeenCalledWith('task-1', 'g1');
  });
});
